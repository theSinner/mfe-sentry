import { Event } from '@sentry/types'

export type SubURL = string | RegExp

export type CustomEventFilterFunction = (
  event: Event,
  fileURL: string,
) => boolean
