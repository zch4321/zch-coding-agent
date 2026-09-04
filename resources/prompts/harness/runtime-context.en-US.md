<environment_context current_date="${currentDate}">
current_time: ${currentTime}
timezone: ${timezone}
workspace: ${workspace}
cwd: ${cwd}
command_shell: ${commandShell}
session_temp: ${sessionTempRoot}
session_artifacts: ${sessionArtifactsDirectory}
session_scratch: ${sessionScratchDirectory}
session_environment: ZCH_SESSION_TEMP_DIR, ZCH_SESSION_ARTIFACTS_DIR, ZCH_SESSION_SCRATCH_DIR
os: ${osInfo}
assistant_language: ${assistantLanguage}
permission_mode: ${permissionMode}
provider: ${providerLabel} (${providerId})
model: ${model}
builtin_policies: ${builtinPolicies}
remembered_rules: ${rememberedRules}
sensitive_data_mode: ${sensitiveDataMode}
available_tools: ${availableTools}

${gitSummary}

project_tree_depth_${projectTreeDepth}:
${projectTree}
</environment_context>

<module_context status="${moduleStatus}" semantic_tools="code_intelligence_facade">
${moduleContent}
</module_context>
