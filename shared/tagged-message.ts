import type { JsonValue } from './json'

const XML_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/u

function assertXmlName(value: string, label: string): void {
  if (!XML_NAME_PATTERN.test(value)) {
    throw new TypeError(`Invalid ${label}: ${value}`)
  }
}

/** Escapes literal text so it cannot terminate an XML-like harness block. */
export function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/** Restores literal text escaped by escapeXmlText. */
export function unescapeXmlText(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

/** Escapes one XML-like harness attribute value. */
export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replaceAll('"', '&quot;')
}

/** Wraps trimmed literal text in a safely escaped harness tag. */
export function renderTaggedText(tag: string, value: string): string {
  assertXmlName(tag, 'tag name')
  return `<${tag}>\n${escapeXmlText(value.trim())}\n</${tag}>`
}

/** Returns literal text from a matching escaped harness tag. */
export function unwrapTaggedText(
  tag: string,
  value: string,
): string | undefined {
  assertXmlName(tag, 'tag name')
  const trimmed = value.trim()
  const opening = `<${tag}>\n`
  const closing = `\n</${tag}>`
  if (!trimmed.startsWith(opening) || !trimmed.endsWith(closing)) {
    return undefined
  }
  return unescapeXmlText(trimmed.slice(opening.length, -closing.length))
}

/** Wraps JSON in a harness tag while preserving valid JSON and neutralizing nested tags. */
export function renderTaggedJson(
  tag: string,
  value: JsonValue,
  attributes: Readonly<Record<string, string>> = {},
): string {
  assertXmlName(tag, 'tag name')
  const renderedAttributes = Object.entries(attributes)
    .map(([name, attributeValue]) => {
      assertXmlName(name, 'attribute name')
      return ` ${name}="${escapeXmlAttribute(attributeValue)}"`
    })
    .join('')
  // JSON Unicode escapes keep the body parseable as JSON. XML entities would
  // change string values until a separate XML decoding pass restored them.
  const serialized = JSON.stringify(value)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
  return `<${tag}${renderedAttributes}>\n${serialized}\n</${tag}>`
}
