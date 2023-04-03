import { Hub } from '@sentry/browser'
import {
  Extras,
  Event,
  Exception,
  StackParser,
  StackFrame,
  EventHint,
} from '@sentry/types'
import {
  isPlainObject,
  isError,
  isDOMError,
  isEvent,
  isDOMException,
  normalizeToSize,
  extractExceptionKeysForMessage,
  isErrorEvent,
  addExceptionMechanism,
  addExceptionTypeValue,
  getLocationHref,
  isString,
} from '@sentry/utils'

import { AxiosError } from 'axios'

import { reactMinifiedRegexp } from './constants'
import { CustomEventFilterFunction, SubURL } from './types'

const doesIncludeSubURLs = (
  url: string,
  subURLs: (string | RegExp)[],
): boolean | null => {
  if (subURLs.length === 0) {
    return null
  }
  return subURLs.some((subURL) => {
    if (subURL instanceof RegExp) {
      return url.match(subURL) != null
    } else {
      return url.includes(subURL)
    }
  })
}

export const shouldCaptureError = (
  event: Event,
  url: string,
  allowUrls: SubURL[],
  denyUrls: SubURL[],
  customEventFilter?: CustomEventFilterFunction,
) => {
  if (denyUrls.length > 0 && doesIncludeSubURLs(url, denyUrls)) {
    return false
  }
  if (allowUrls.length > 0 && !doesIncludeSubURLs(url, allowUrls)) {
    return true
  }
  if (customEventFilter) {
    return customEventFilter(event, url)
  }
  return true
}

// Copied functions from Sentry since they are not exported

function extractMessage(ex: Error & { message: { error?: Error } }): string {
  const message = ex && ex.message
  if (!message) {
    return 'No error message'
  }
  if (message.error && typeof message.error.message === 'string') {
    return message.error.message
  }
  return message
}

function getPopSize(ex: Error & { framesToPop?: number }): number {
  if (ex) {
    if (typeof ex.framesToPop === 'number') {
      return ex.framesToPop
    }

    if (reactMinifiedRegexp.test(ex.message)) {
      return 1
    }
  }

  return 0
}

export function parseStackFrames(
  stackParser: StackParser,
  ex: Error & { framesToPop?: number; stacktrace?: string },
): StackFrame[] {
  // Access and store the stacktrace property before doing ANYTHING
  // else to it because Opera is not very good at providing it
  // reliably in other circumstances.
  const stacktrace = ex.stacktrace || ex.stack || ''

  const popSize = getPopSize(ex)

  try {
    return stackParser(stacktrace, popSize)
  } catch (e) {
    // no-empty
  }

  return []
}

export function exceptionFromError(
  stackParser: StackParser,
  ex: Error,
): Exception {
  // Get the frames first since Opera can lose the stack if we touch anything else first
  const frames = parseStackFrames(stackParser, ex)

  const exception: Exception = {
    type: ex && ex.name,
    value: extractMessage(ex),
  }

  if (frames.length) {
    exception.stacktrace = { frames }
  }

  if (exception.type === undefined && exception.value === '') {
    exception.value = 'Unrecoverable error caught'
  }

  return exception
}

export const handleErrorBoundary = (hub: Hub, error: Error, info: unknown) => {
  hub.run((currentHub) => {
    currentHub.withScope((scope) => {
      scope.setExtras(info as Extras)
      currentHub.captureException(error)
    })
  })
}

export function eventFromString(
  stackParser: StackParser,
  input: string,
  syntheticException?: Error,
  attachStacktrace?: boolean,
): Event {
  const event: Event = {
    message: input,
  }

  if (attachStacktrace && syntheticException) {
    const frames = parseStackFrames(stackParser, syntheticException)
    if (frames.length) {
      event.exception = {
        values: [{ value: input, stacktrace: { frames } }],
      }
    }
  }

  return event
}

export function eventFromError(stackParser: StackParser, ex: Error): Event {
  return {
    exception: {
      values: [exceptionFromError(stackParser, ex)],
    },
  }
}

export function eventFromPlainObject(
  hub: Hub,
  stackParser: StackParser,
  exception: Record<string, unknown>,
  syntheticException?: Error,
  isUnhandledRejection?: boolean,
): Event {
  const client = hub.getClient()
  const normalizeDepth = client && client.getOptions().normalizeDepth

  const event: Event = {
    exception: {
      values: [
        {
          type: isEvent(exception)
            ? exception.constructor.name
            : isUnhandledRejection
            ? 'UnhandledRejection'
            : 'Error',
          value: `Non-Error ${
            isUnhandledRejection ? 'promise rejection' : 'exception'
          } captured with keys: ${extractExceptionKeysForMessage(exception)}`,
        },
      ],
    },
    extra: {
      __serialized__: normalizeToSize(exception, normalizeDepth),
    },
  }

  if (syntheticException) {
    const frames = parseStackFrames(stackParser, syntheticException)
    if (frames.length) {
      // eslint-disable-next-line prettier/prettier
      (event.exception as { values: Exception[] }).values[0].stacktrace = {
        frames,
      }
    }
  }

  return event
}

export function eventFromUnknownInput(
  hub: Hub,
  stackParser: StackParser,
  exception: unknown,
  syntheticException?: Error,
  attachStacktrace?: boolean,
  isUnhandledRejection?: boolean,
): Event {
  let event: Event

  if (
    isErrorEvent(exception as ErrorEvent) &&
    (exception as ErrorEvent).error
  ) {
    // If it is an ErrorEvent with `error` property, extract it to get actual Error
    const errorEvent = exception as ErrorEvent
    return eventFromError(stackParser, errorEvent.error as Error)
  }

  // If it is a `DOMError` (which is a legacy API, but still supported in some browsers) then we just extract the name
  // and message, as it doesn't provide anything else. According to the spec, all `DOMExceptions` should also be
  // `Error`s, but that's not the case in IE11, so in that case we treat it the same as we do a `DOMError`.
  //
  // https://developer.mozilla.org/en-US/docs/Web/API/DOMError
  // https://developer.mozilla.org/en-US/docs/Web/API/DOMException
  // https://webidl.spec.whatwg.org/#es-DOMException-specialness
  if (
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    isDOMError(exception as DOMError) ||
    isDOMException(exception as DOMException)
  ) {
    const domException = exception as DOMException

    if ('stack' in (exception as Error)) {
      event = eventFromError(stackParser, exception as Error)
    } else {
      const name =
        domException.name ||
        (isDOMError(domException) ? 'DOMError' : 'DOMException')
      const message = domException.message
        ? `${name}: ${domException.message}`
        : name
      event = eventFromString(
        stackParser,
        message,
        syntheticException,
        attachStacktrace,
      )
      addExceptionTypeValue(event, message)
    }
    if ('code' in domException) {
      event.tags = {
        ...event.tags,
        'DOMException.code': `${domException.code}`,
      }
    }

    return event
  }
  if (isError(exception)) {
    // we have a real Error object, do nothing
    return eventFromError(stackParser, exception)
  }
  if (isPlainObject(exception) || isEvent(exception)) {
    // If it's a plain object or an instance of `Event` (the built-in JS kind, not this SDK's `Event` type), serialize
    // it manually. This will allow us to group events based on top-level keys which is much better than creating a new
    // group on any key/value change.
    const objectException = exception as Record<string, unknown>
    event = eventFromPlainObject(
      hub,
      stackParser,
      objectException,
      syntheticException,
      isUnhandledRejection,
    )
    addExceptionMechanism(event, {
      synthetic: true,
    })
    return event
  }

  // If none of previous checks were valid, then it means that it's not:
  // - an instance of DOMError
  // - an instance of DOMException
  // - an instance of Event
  // - an instance of Error
  // - a valid ErrorEvent (one with an error property)
  // - a plain Object
  //
  // So bail out and capture it as a simple message:
  event = eventFromString(
    stackParser,
    exception as string,
    syntheticException,
    attachStacktrace,
  )
  addExceptionTypeValue(event, `${exception}`, undefined)
  addExceptionMechanism(event, {
    synthetic: true,
  })

  return event
}

const getLastValidUrl = (frames: StackFrame[] = []): string | null => {
  if (!frames) {
    return null
  }
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i]

    if (
      frame &&
      frame.filename !== '<anonymous>' &&
      frame.filename !== '[native code]'
    ) {
      return frame.filename || null
    }
  }

  return null
}

export function isNetworkError(error: any): boolean {
  if (error instanceof AxiosError) {
    return true
  }
  if ('name' in error && error.name === 'NetworkError') {
    return true
  }
  return false
}

export const getEventFilterUrl = (event: Event): string | null => {
  try {
    let frames
    try {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore we only care about frames if the whole thing here is defined
      frames = event.exception.values[0].stacktrace.frames
    } catch (e) {
      // ignore
    }
    return getLastValidUrl(frames)
  } catch (oO) {
    return null
  }
}

export const addMechanismAndCapture = (
  hub: Hub,
  error: EventHint['originalException'],
  event: Event,
  type: string,
): void => {
  addExceptionMechanism(event, {
    handled: false,
    type,
  })
  hub.captureEvent(event, {
    originalException: error,
  })
}

export function enhanceEventWithInitialFrame(
  event: Event,
  url: any,
  line: any,
  column: any,
): Event {
  // event.exception
  const e = (event.exception = event.exception || {})
  // event.exception.values
  const ev = (e.values = e.values || [])
  // event.exception.values[0]
  const ev0 = (ev[0] = ev[0] || {})
  // event.exception.values[0].stacktrace
  const ev0s = (ev0.stacktrace = ev0.stacktrace || {})
  // event.exception.values[0].stacktrace.frames
  const ev0sf = (ev0s.frames = ev0s.frames || [])

  const colno = isNaN(parseInt(column, 10)) ? undefined : column
  const lineno = isNaN(parseInt(line, 10)) ? undefined : line
  const filename = isString(url) && url.length > 0 ? url : getLocationHref()

  // event.exception.values[0].stacktrace.frames
  if (ev0sf.length === 0) {
    ev0sf.push({
      colno,
      filename,
      function: '?',
      in_app: true,
      lineno,
    })
  }

  return event
}

export function eventFromIncompleteOnError(
  msg: any,
  url: any,
  line: any,
  column: any,
): Event {
  const ERROR_TYPES_RE =
    /^(?:[Uu]ncaught (?:exception: )?)?(?:((?:Eval|Internal|Range|Reference|Syntax|Type|URI|)Error): )?(.*)$/i

  // If 'message' is ErrorEvent, get real message from inside
  let message = isErrorEvent(msg) ? msg.message : msg
  let name = 'Error'

  const groups = message.match(ERROR_TYPES_RE)
  if (groups) {
    name = groups[1]
    message = groups[2]
  }

  const event = {
    exception: {
      values: [
        {
          type: name,
          value: message,
        },
      ],
    },
  }

  return enhanceEventWithInitialFrame(event, url, line, column)
}
