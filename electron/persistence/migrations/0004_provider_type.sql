UPDATE messages
SET model_route_json = json_remove(
  json_set(
    model_route_json,
    '$.schemaVersion',
    2,
    '$.providerType',
    CASE json_extract(model_route_json, '$.adapterId')
      WHEN 'openai-compatible.chat-completions' THEN 'generic.chat-completions'
      ELSE json_extract(model_route_json, '$.adapterId')
    END
  ),
  '$.adapterId'
)
WHERE model_route_json IS NOT NULL
  AND json_type(model_route_json, '$.adapterId') = 'text';

UPDATE messages
SET provider_continuation_json = json_remove(
  json_set(
    provider_continuation_json,
    '$.schemaVersion',
    2,
    '$.providerType',
    CASE json_extract(provider_continuation_json, '$.adapterId')
      WHEN 'openai-compatible.chat-completions' THEN 'generic.chat-completions'
      ELSE json_extract(provider_continuation_json, '$.adapterId')
    END
  ),
  '$.adapterId'
)
WHERE provider_continuation_json IS NOT NULL
  AND json_type(provider_continuation_json, '$.adapterId') = 'text';
