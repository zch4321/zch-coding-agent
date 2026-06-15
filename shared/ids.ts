import { Type, type Static, type TSchema } from '@sinclair/typebox'

declare const brand: unique symbol

export type BrandedId<Name extends string> = string & {
  readonly [brand]: Name
}

export type SessionId = BrandedId<'SessionId'>
export type RunId = BrandedId<'RunId'>
export type CallId = BrandedId<'CallId'>
export type TerminalId = BrandedId<'TerminalId'>
export type EventId = BrandedId<'EventId'>

function idSchema<Name extends string>(name: Name) {
  return Type.Unsafe<BrandedId<Name>>(
    Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
      title: name,
    }),
  )
}

export const SessionIdSchema = idSchema('SessionId')
export const RunIdSchema = idSchema('RunId')
export const CallIdSchema = idSchema('CallId')
export const TerminalIdSchema = idSchema('TerminalId')
export const EventIdSchema = idSchema('EventId')

export type IdSchemaValue<Schema extends TSchema> = Static<Schema>
