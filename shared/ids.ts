import { Type, type Static, type TSchema } from '@sinclair/typebox'

declare const brand: unique symbol

export type BrandedId<Name extends string> = string & {
  readonly [brand]: Name
}

export type ProjectId = BrandedId<'ProjectId'>
export type SessionId = BrandedId<'SessionId'>
export type MessageId = BrandedId<'MessageId'>
export type FileChangeId = BrandedId<'FileChangeId'>
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

export const ProjectIdSchema = idSchema('ProjectId')
export const SessionIdSchema = idSchema('SessionId')
export const MessageIdSchema = idSchema('MessageId')
export const FileChangeIdSchema = idSchema('FileChangeId')
export const RunIdSchema = idSchema('RunId')
export const CallIdSchema = idSchema('CallId')
export const TerminalIdSchema = idSchema('TerminalId')
export const EventIdSchema = idSchema('EventId')

export type IdSchemaValue<Schema extends TSchema> = Static<Schema>
