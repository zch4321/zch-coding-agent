import { Type, type Static } from '@sinclair/typebox'

export const MAX_TODO_ITEMS = 128
export const MAX_TODO_STEP_LENGTH = 1_024
export const MAX_TODO_EXPLANATION_LENGTH = 65_536
export const TODO_TOOL_ID = 'todo_update'

export const TodoItemStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('in_progress'),
  Type.Literal('completed'),
])
export type TodoItemStatus = Static<typeof TodoItemStatusSchema>

export const TodoItemSchema = Type.Object(
  {
    step: Type.String({
      minLength: 1,
      maxLength: MAX_TODO_STEP_LENGTH,
      description: 'One short, concrete task step.',
    }),
    status: TodoItemStatusSchema,
  },
  { additionalProperties: false },
)
export type TodoItem = Static<typeof TodoItemSchema>

export const TodoStateSchema = Type.Object(
  {
    explanation: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: MAX_TODO_EXPLANATION_LENGTH,
        description: 'Optional explanation for this checklist update.',
      }),
    ),
    items: Type.Array(TodoItemSchema, {
      maxItems: MAX_TODO_ITEMS,
      description:
        'Complete ordered checklist snapshot. At most one item may be in_progress.',
    }),
  },
  { additionalProperties: false },
)
export type TodoState = Static<typeof TodoStateSchema>
