import { safeErrorString } from '~/server/wire';
import { serverSideId } from '~/server/api/trpc.nanoid';

import type { ChatGenerateParseFunction } from '../chatGenerate.dispatch';
import type { IPartTransmitter } from '../IPartTransmitter';
import { IssueSymbols } from '../ChatGenerateTransmitter';

import { OpenAIWire_API_Chat_Completions } from '../../wiretypes/openai.wiretypes';


/**
 * OpenAI Streaming Completions -  Messages Architecture
 *
 * OpenAI uses a chunk-based streaming protocol for its chat completions:
 * 1. Each chunk contains a 'choices' array, typically with a single item.
 * 2. The 'delta' field in each choice contains incremental updates to the message.
 * 3. Text content is streamed as string fragments in delta.content.
 * 4. Tool calls (function calls) are streamed incrementally in delta.tool_calls.
 * 5. There may be a final chunk which may contain a 'finish_reason' - but we won't rely on it.
 *
 * Assumptions:
 * - 'text' parts are incremental
 * - 'functionCall' are streamed incrementally, but follow a scheme.
 *    1. the firs delta chunk contains the the full ID and name of the function, and likley empty arguments.
 *    2. Subsequent delta chunks will only contain incremental text for the arguments.
 * - Begin/End: at any point:
 *    - it's either streaming Text or Tool Calls on each chunk
 *    - and there can be multiple chunks for a single completion (e.g. a text chunk and a tool call 1 chunk)
 *    - the temporal order of the chunks implies the beginning/end of a tool call.
 * - There's no explicit end in this data protocol, but it's handled in the caller with a sse:[DONE] event.
 */
export function createOpenAIChatCompletionsChunkParser(): ChatGenerateParseFunction {
  let hasBegun = false;
  let hasWarned = false;
  // NOTE: could compute rate (tok/s) from the first textful event to the last (to ignore the prefill time)

  // Supporting structure to accumulate the assistant message
  const accumulator: {
    content: string | null;
    tool_calls: {
      id: string;
      type: 'function';
      function: {
        name: string;
        arguments: string | null;
      };
    }[];
  } = {
    content: null,
    tool_calls: [],
  };

  return function(pt: IPartTransmitter, eventData: string) {

    // Throws on malformed event data
    // ```Can you extend the Zod chunk response object parsing (all optional) to include the missing data? The following is an exampel of the object I received:```
    const parsedData = JSON.parse(eventData); // this is here just for ease of breakpoint, otherwise it could be inlined
    const json = OpenAIWire_API_Chat_Completions.ChunkResponse_schema.parse(parsedData);

    // -> Model
    if (!hasBegun && json.model) {
      hasBegun = true;
      pt.setModelName(json.model);
    }

    // [OpenAI] an upstream error will be handled gracefully and transmitted as text (throw to transmit as 'error')
    if (json.error) {
      return pt.setDialectTerminatingIssue(safeErrorString(json.error) || 'unknown.', IssueSymbols.Generic);
    }

    // [OpenAI] if there's a warning, log it once
    if (json.warning && !hasWarned) {
      hasWarned = true;
      console.log('AIX: OpenAI-dispatch chunk warning:', json.warning);
    }

    // [Azure] we seem to get 'prompt_annotations' or 'prompt_filter_results' objects - which we will ignore to suppress the error
    if (json.id === '' && json.object === '' && json.model === '')
      return;


    // -> Stats
    if (json.usage) {
      if (json.usage.completion_tokens !== undefined)
        pt.setCounters({
          chatIn: json.usage.prompt_tokens || -1,
          chatOut: json.usage.completion_tokens,
        });

      // [OpenAI] Expected correct case: the last object has usage, but an empty choices array
      if (!json.choices.length)
        return;
    }
    // [Groq] -> Stats
    if (json.x_groq?.usage) {
      const { prompt_tokens, completion_tokens, completion_time } = json.x_groq.usage;
      pt.setCounters({
        chatIn: prompt_tokens,
        chatOut: completion_tokens,
        chatOutRate: (completion_tokens && completion_time) ? Math.round((completion_tokens / completion_time) * 100) / 100 : undefined,
        chatTimeInner: completion_time,
      });
    }

    // expect: 1 completion, or stop
    if (json.choices.length !== 1)
      throw new Error(`expected 1 completion, got ${json.choices.length}`);

    for (const { index, delta, finish_reason } of json.choices) {

      // n=1 -> single Choice only
      if (index !== 0 && index !== undefined /* [OpenRouter->Gemini] */)
        throw new Error(`expected completion index 0, got ${index}`);

      // handle missing content
      if (!delta)
        throw new Error(`server response missing content (finish_reason: ${finish_reason})`);

      // delta: Text
      if (typeof delta.content === 'string') {

        accumulator.content = (accumulator.content || '') + delta.content;
        pt.appendText(delta.content);

      } else if (delta.content !== undefined && delta.content !== null)
        throw new Error(`unexpected delta content type: ${typeof delta.content}`);

      // delta: Tool Calls
      for (const deltaToolCall of (delta.tool_calls || [])) {

        // validation
        if (deltaToolCall.type !== undefined && deltaToolCall.type !== 'function')
          throw new Error(`unexpected tool_call type: ${deltaToolCall.type}`);

        // Creation -  Ensure the tool call exists in our accumulated structure
        const tcIndex = deltaToolCall.index ?? accumulator.tool_calls.length;
        if (!accumulator.tool_calls[tcIndex]) {
          const created = accumulator.tool_calls[tcIndex] = {
            id: deltaToolCall.id || serverSideId('aix-tool-call-id'),
            type: 'function',
            function: {
              name: deltaToolCall.function.name || '',
              arguments: deltaToolCall.function.arguments || '',
            },
          };
          pt.startFunctionToolCall(created.id, created.function.name, 'incr_str', created.function.arguments);
          break;
        }

        // Updating arguments
        const accumulatedToolCall = accumulator.tool_calls[tcIndex];

        // Validate
        if (deltaToolCall.id && deltaToolCall.id !== accumulatedToolCall.id)
          throw new Error(`unexpected tool_call id change: ${deltaToolCall.id}`);
        if (deltaToolCall.function.name)
          throw new Error(`unexpected tool_call name change: ${deltaToolCall.function.name}`);

        // It's an arguments update - send it
        if (deltaToolCall.function?.arguments) {
          accumulatedToolCall.function.arguments += deltaToolCall.function.arguments;
          pt.appendFunctionToolCallArgsIStr(accumulatedToolCall.id, deltaToolCall.function.arguments);
        }

      } // .choices.tool_calls[]

      // Finish reason: we don't really need it
      // Empirically, different dialects will have different reasons for stopping
      // if (finish_reason)
      //   pt.setFinishReason(... some mapping ...);
      // Note: not needed anymore - Workaround for implementations that don't send the [DONE] event
      // if (finish_reason === 'max_tokens')
      //   pt.terminateParser('finish-reason');

    } // .choices[]

  };
}


/// OpenAI non-streaming ChatCompletions

export function createOpenAIChatCompletionsParserNS(): ChatGenerateParseFunction {

  return function(pt: IPartTransmitter, eventData: string) {

    // Throws on malformed event data
    const json = OpenAIWire_API_Chat_Completions.Response_schema.parse(JSON.parse(eventData));

    // [OpenAI] we don't know if error messages are sent in the non-streaming version - for now we log
    if (json.error)
      console.log('AIX: OpenAI-dispatch-NS error:', json.error);
    if (json.warning)
      console.log('AIX: OpenAI-dispatch-NS warning:', json.warning);

    // -> Model
    if (json.model)
      pt.setModelName(json.model);

    // -> Stats
    if (json.usage)
      pt.setCounters({
        chatIn: json.usage.prompt_tokens,
        chatOut: json.usage.completion_tokens,
      });

    // Assumption/validate: expect 1 completion, or stop
    if (json.choices.length !== 1)
      throw new Error(`expected 1 completion, got ${json.choices.length}`);

    for (const { index, message, finish_reason } of json.choices) {

      // n=1 -> single Choice only
      if (index !== 0)
        throw new Error(`expected completion index 0, got ${index}`);

      // handle missing content
      if (!message)
        throw new Error(`server response missing content (finish_reason: ${finish_reason})`);

      // message: Text
      if (typeof message.content === 'string') {
        if (message.content)
          pt.appendText(message.content);
      } else if (message.content !== undefined && message.content !== null)
        throw new Error(`unexpected message content type: ${typeof message.content}`);

      // message: Tool Calls
      for (const toolCall of (message.tool_calls || [])) {

        // [Mistral] we had to relax the parser to miss type: 'function', as Mistral does not generate it
        // Note that we relaxed the
        const mayBeMistral = toolCall.type === undefined;

        if (toolCall.type !== 'function' && !mayBeMistral)
          throw new Error(`unexpected tool_call type: ${toolCall.type}`);
        pt.startFunctionToolCall(toolCall.id, toolCall.function.name, 'incr_str', toolCall.function.arguments);
        pt.endMessagePart();
      } // .choices.tool_calls[]

      // Finish reason: we don't really need it
      // ...

    } // .choices[]

  };
}
