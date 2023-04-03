import {
  Hub,
  BrowserClient,
  EventHint,
  SeverityLevel,
  User,
} from '@sentry/browser'
import {
  ClientOptions,
  Extras,
  StackParser,
  Event,
  Primitive,
} from '@sentry/types'
import { isPrimitive, isString } from '@sentry/utils'

import { CustomEventFilterFunction, SubURL } from './types'
import {
  isNetworkError,
  getEventFilterUrl,
  addMechanismAndCapture,
  eventFromUnknownInput,
  eventFromIncompleteOnError,
  shouldCaptureError,
  enhanceEventWithInitialFrame,
} from './utils'

export class MFESentry {
  public static hub: Hub

  public static client: BrowserClient

  public static appJSFile?: string

  public static customEventFilter?: CustomEventFilterFunction

  public static setClientAndHub(hub: Hub, client: BrowserClient) {
    MFESentry.hub = hub
    MFESentry.client = client
  }

  public static createClient(
    options: ClientOptions,
    appJSFile?: string,
    customEventFilter?: CustomEventFilterFunction,
  ): {
    client: BrowserClient
    hub: Hub
  } {
    const client = new BrowserClient(options)
    const hub = new Hub(client)
    hub.bindClient(client)
    MFESentry.setClientAndHub(hub, client)
    MFESentry.appJSFile = appJSFile
    MFESentry.customEventFilter = customEventFilter
    return { client, hub }
  }

  public static captureExecption = (
    error: any,
    hint?: EventHint,
    forceSendingNetworkError?: boolean,
  ) => {
    if (MFESentry.hub && (forceSendingNetworkError || !isNetworkError(error))) {
      MFESentry.hub.run((currentHub) => {
        currentHub.captureException(error, hint)
      })
    }
  }

  public static captureEvent = (error: Error, hint?: EventHint) => {
    if (MFESentry.hub) {
      MFESentry.hub.run((currentHub) => {
        currentHub.captureEvent(error, hint)
      })
    }
  }

  public static captureMessage = (
    error: string,
    severity?: SeverityLevel,
    hint?: EventHint,
  ) => {
    if (MFESentry.hub) {
      MFESentry.hub.run((currentHub) => {
        currentHub.captureMessage(error, severity, hint)
      })
    }
  }

  public static setUser = (user: User | null) => {
    if (MFESentry.hub) {
      MFESentry.hub.run((currentHub) => {
        currentHub.setUser(user)
      })
    }
  }

  public static setExtras = (extras: Extras) => {
    if (MFESentry.hub) {
      MFESentry.hub.run((currentHub) => {
        currentHub.setExtras(extras)
      })
    }
  }

  // Copied functions from Sentry since they are not exported

  private static _eventFromRejectionWithPrimitive(reason: Primitive): Event {
    return {
      exception: {
        values: [
          {
            type: 'UnhandledRejection',
            // String() is needed because the Primitive type includes symbols (which can't be automatically stringified)
            value: `Non-Error promise rejection captured with value: ${String(
              reason,
            )}`,
          },
        ],
      },
    }
  }

  public static handleUnhandledRejection = (e: any) => {
    const { stackParser, attachStacktrace } = MFESentry.getHubOptions()

    let error = e
    // dig the object of the rejection out of known event types
    try {
      // PromiseRejectionEvents store the object of the rejection under 'reason'
      // see https://developer.mozilla.org/en-US/docs/Web/API/PromiseRejectionEvent
      if ('reason' in e) {
        error = e.reason
      }
      // something, somewhere, (likely a browser extension) effectively casts PromiseRejectionEvents
      // to CustomEvents, moving the `promise` and `reason` attributes of the PRE into
      // the CustomEvent's `detail` attribute, since they're not part of CustomEvent's spec
      // see https://developer.mozilla.org/en-US/docs/Web/API/CustomEvent and
      // https://github.com/getsentry/sentry-javascript/issues/2380
      else if ('detail' in e && 'reason' in e.detail) {
        error = e.detail.reason
      }
    } catch (_oO) {
      // no-empty
    }

    if (error && error.__sentry_own_request__) {
      return true
    }

    const event = isPrimitive(error)
      ? MFESentry._eventFromRejectionWithPrimitive(error)
      : eventFromUnknownInput(
          MFESentry.hub,
          stackParser,
          error,
          undefined,
          attachStacktrace,
          true,
        )

    event.level = 'error'
    const eventFilterURL = getEventFilterUrl(event)
    if (eventFilterURL) {
      if (
        MFESentry.appJSFile &&
        !eventFilterURL.includes(MFESentry.appJSFile)
      ) {
        return
      }
      if (
        MFESentry.customEventFilter &&
        !MFESentry.customEventFilter(event, eventFilterURL)
      ) {
        return
      }
      if (
        e.stopImmediatePropagation &&
        typeof e.stopImmediatePropagation === 'function'
      ) {
        e.stopImmediatePropagation()
      }
      addMechanismAndCapture(
        MFESentry.hub,
        error,
        event,
        'onunhandledrejection',
      )
    }
    return
  }

  public static handleOnError = (data: ErrorEvent) => {
    const { stackParser, attachStacktrace, allowUrls, denyUrls } =
      MFESentry.getHubOptions()

    const { message, filename: url, lineno: line, colno: column, error } = data
    if (
      !shouldCaptureError(error, url, allowUrls, denyUrls) ||
      (error && error.__sentry_own_request__)
    ) {
      return
    }

    const event =
      error === undefined && isString(message)
        ? eventFromIncompleteOnError(message, url, line, column)
        : enhanceEventWithInitialFrame(
            eventFromUnknownInput(
              MFESentry.hub,
              stackParser,
              error || message,
              undefined,
              attachStacktrace,
              false,
            ),
            url,
            line,
            column,
          )

    event.level = 'error'

    addMechanismAndCapture(MFESentry.hub, error, event, 'onerror')
  }

  public static getHubOptions = (): {
    stackParser: StackParser
    attachStacktrace: boolean | undefined
    allowUrls: SubURL[]
    denyUrls: SubURL[]
  } => {
    const options = (MFESentry.client && MFESentry.client.getOptions()) || {
      stackParser: () => [],
      attachStacktrace: false,
      allowUrls: [],
      denyUrls: [],
    }

    return {
      stackParser: options.stackParser,
      attachStacktrace: options.attachStacktrace,
      allowUrls: options.allowUrls ?? [],
      denyUrls: options.denyUrls ?? [],
    }
  }
}
