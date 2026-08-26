# i18n Migration Backlog

Hardcoded-CJK audit of src/**/*.{ts,tsx} (locales/tests excluded). Format: file|CJK-lines.

## Completed

- src/components/providers/ProviderEmptyState.tsx (importFromClaude key, all locales)
- src/components/sessions/SessionItem.tsx (selectForBatch key, all locales)
- Verified comment-only files (no UI strings): UnifiedSkillsPanel.tsx, PromptListItem.tsx, BrandIcons.tsx, sessions/utils.ts
- src/components/AppErrorBoundary.tsx (UI strings -> errorBoundary.* keys in all 4 locales; console.error dev logs intentionally untranslated)
- usage.clearLogs key added to all locales


## Cleared: comment/console-only (no UI strings)
- src/components/env/EnvWarningBanner.tsx
- src/hooks/useDebouncedValue.ts
- src/components/providers/forms/hooks/useManagedAuth.ts
- src/hooks/useTauriEvent.ts
- src/components/settings/LogConfigPanel.tsx
- src/hooks/useSessionSearch.ts
- src/lib/api/types.ts


## Completed (round 4)
- SessionMessageItem.tsx: copyMessage/collapseContent/expandContent keys (all locales)
- RequestLogTable.tsx: usage.unpriced key
- FailoverPriorityBadge.tsx: failover.priority.tooltip key


## Completed (round 5)
- ApiKeySection.tsx: officialNoApiKey/apiKeyAutoFill/getApiKey keys (all locales)
- FrontendErrorBoundary.tsx: frontendCrashTitle/frontendCrashMessage/reloadInterface keys


## Cleared: keys exist in all locales, Chinese defaults are dormant fallbacks (no UI impact)

- FailoverToggle.tsx, EndpointField.tsx, GeminiCommonConfigModal.tsx, ClaudeDesktopRouteToggle.tsx (all 12 flagged keys verified present with EN values; Chinese defaults dormant)
- AuthCenterPanel.tsx (all 6 keys verified present with EN values)
- CommonConfigEditor.tsx (all 4 flagged keys verified present)

## Remaining (file|count)
src\components\codex\CodexRouterWorkspacePage.tsx|757
src\components\codex\CodexMultiRouterWizard.tsx|274
src\types.ts|222
src\components\providers\forms\CodexFormFields.tsx|204
src\components\codex\CodexSubagentProfileEditor.tsx|187
src\components\codex\CodexUsagePage.tsx|169
src\components\sessions\CodexHistoryRepairPanel.tsx|120
src\components\openai\OpenAICompatibleApiPage.tsx|118
src\config\codexProviderPresets.ts|100
src\components\settings\AboutSection.tsx|98
src\components\providers\forms\ProviderForm.tsx|92
src\components\UsageScriptModal.tsx|83
src\utils\providerConfigUtils.ts|81
src\config\claudeProviderPresets.ts|76
src\lib\query\queries.ts|73
src\components\sessions\SessionManagerPage.tsx|66
src\components\providers\forms\CodexOAuthSection.tsx|66
src\App.tsx|64
src\components\providers\forms\ClaudeDesktopProviderForm.tsx|64
src\components\providers\forms\CodexModelReasoningCard.tsx|60
src\lib\api\copilot.ts|58
src\components\proxy\ProxyPanel.tsx|53
src\components\universal\UniversalProviderFormModal.tsx|52
src\utils\deeplinkRisk.ts|51
src\lib\codexMultiRouterWizard.ts|51
src\components\providers\forms\hooks\useCodexCommonConfig.ts|49
src\components\proxy\AutoFailoverConfigPanel.tsx|48
src\components\providers\ProviderCard.tsx|47
src\hooks\useProviderActions.ts|47
src\components\providers\forms\ClaudeFormFields.tsx|45
src\components\providers\forms\CopilotAuthSection.tsx|44
src\components\UsageFooter.tsx|44
src\components\providers\forms\hooks\useGeminiCommonConfig.ts|44
src\hooks\useSettings.ts|42
src\components\providers\forms\hooks\useCommonConfigSnippet.ts|42
src\components\usage\RequestDetailPanel.tsx|42
src\components\providers\forms\EndpointSpeedTest.tsx|41
src\lib\openai\externalProfile.ts|41
src\components\universal\UniversalProviderPanel.tsx|40
src\utils\tomlUtils.ts|40
src\lib\api\skills.ts|37
src\components\SubscriptionQuotaFooter.tsx|37
src\components\providers\forms\CodexModelReasoningEditor.tsx|37
src\utils\errorUtils.ts|36
src\lib\query\failover.ts|34
src\components\skills\SkillsPage.tsx|34
src\components\DeepLinkImportDialog.tsx|32
src\components\DatabaseUpgrade.tsx|31
src\hooks\useSkills.ts|31
src\lib\api\providers.ts|31
src\components\proxy\FailoverQueueManager.tsx|30
src\components\providers\ProviderList.tsx|30
src\lib\frontendLogger.ts|29
src\components\providers\forms\OpenClawFormFields.tsx|29
src\lib\api\config.ts|28
src\components\providers\forms\hooks\useCodexConfigState.ts|28
src\components\providers\forms\ProviderPresetSelector.tsx|27
src\config\codingPlanProviders.ts|27
src\hooks\useProxyStatus.ts|27
src\lib\api\proxy.ts|25
src\lib\query\subscription.ts|25
src\components\usage\ModelsDevPickerDialog.tsx|24
src\components\providers\forms\hooks\useGeminiConfigState.ts|24
src\types\codexSubagentV2.ts|24
src\config\grokBuildProviderPresets.ts|22
src\components\usage\UsageDashboard.tsx|22
src\components\providers\ProviderActions.tsx|21
src\config\universalProviderPresets.ts|21
src\components\providers\EditProviderDialog.tsx|21
src\components\providers\forms\XaiOAuthSection.tsx|21
src\components\providers\forms\hooks\useSpeedTestEndpoints.ts|21
src\utils\formatters.ts|21
src\config\claudeDesktopProviderPresets.ts|21
src\components\usage\PricingEditModal.tsx|21
src\components\openai\ExternalBackendPicker.tsx|21
src\lib\codexModelCatalogOrder.ts|20
src\components\JsonEditor.tsx|19
src\components\AppErrorBoundary.tsx|19
src\lib\api\globalProxy.ts|18
src\lib\api\model-fetch.ts|18
src\lib\query\mutations.ts|18
src\lib\version.ts|18
src\lib\api\profiles.ts|18
src\components\common\FullScreenPanel.tsx|17
src\components\providers\forms\HermesFormFields.tsx|17
src\components\providers\AddProviderDialog.tsx|16
src\main.tsx|16
src\contexts\UpdateContext.tsx|15
src\components\mcp\McpWizardModal.tsx|15
src\components\settings\GlobalProxySettings.tsx|15
src\lib\errors\skillErrorParser.ts|15
src\components\providers\forms\GrokBuildProviderForm.tsx|14
src\lib\schemas\provider.ts|14
src\config\openclawProviderPresets.ts|14
src\components\providers\forms\hooks\useCodexTomlValidation.ts|13
src\components\providers\forms\hooks\useBaseUrlState.ts|13
src\lib\api\failover.ts|13
src\utils\codexPlanModelFetch.ts|13
src\utils\providerCapabilities.ts|13
src\components\settings\SettingsPage.tsx|13
src\components\providers\forms\hooks\useTemplateValues.ts|13
src\components\settings\CodexGlobalConfigSettings.tsx|13
src\hooks\useImportExport.ts|13
src\components\providers\forms\CodexModelReasoningSummary.tsx|13
src\config\geminiProviderPresets.ts|13
src\components\ProviderIcon.tsx|12
src\config\hermesProviderPresets.ts|12
src\components\usage\UsageHero.tsx|12
src\lib\api\env.ts|12
src\lib\query\proxy.ts|12
src\types\usage.ts|12
src\components\providers\forms\ProviderAdvancedConfig.tsx|12
src\utils\providerMetaUtils.ts|12
src\components\universal\UniversalProviderCard.tsx|11
src\lib\presetCatalog.ts|11
src\components\deeplink\McpConfirmation.tsx|11
src\hooks\useStreamCheck.ts|10
src\lib\api\codexSubagentV2.ts|10
src\lib\api\connectivity-check.ts|10
src\lib\api\mcp.ts|10
src\types\env.ts|10
src\utils\codexModelContext.ts|10
src\hooks\useDirectorySettings.ts|10
src\components\CodexOauthAccountQuota.tsx|10
src\config\opencodeProviderPresets.ts|10
src\components\providers\forms\GeminiFormFields.tsx|10
src\components\settings\CodexAuthSettings.tsx|10
src\components\providers\forms\hooks\useApiKeyState.ts|9
src\components\providers\forms\CustomUserAgentField.tsx|9
src\config\mcpPresets.ts|9
src\lib\platform.ts|8
src\types\subscription.ts|8
src\components\providers\forms\hooks\useModelState.ts|8
src\hooks\useGlobalProxy.ts|8
src\components\usage\format.ts|8
src\components\usage\PricingConfigPanel.tsx|8
src\lib\api\settings.ts|8
src\components\providers\ProviderHealthBadge.tsx|8
src\config\userAgentPresets.ts|8
src\components\MarkdownEditor.tsx|8
src\components\mcp\McpFormModal.tsx|7
src\utils\codexSpawnAgentCandidates.ts|7
src\components\providers\forms\OpenCodeFormFields.tsx|7
src\components\providers\forms\OAuthDeleteConfirmDialog.tsx|7
src\hooks\useSettingsForm.ts|7
src\components\usage\UsageTrendChart.tsx|7
src\components\IconPicker.tsx|7
src\utils\textNormalization.ts|7
src\hooks\useMcp.ts|7
src\types\proxy.ts|7
src\hooks\useUsageEventBridge.ts|7
src\components\profiles\ProfileSwitcher.tsx|7
src\lib\schemas\settings.ts|7
src\lib\utils\base64.ts|7
src\components\ui\button.tsx|7
src\components\ui\layer-context.ts|6
src\components\providers\forms\LocalProxyRequestOverridesField.tsx|6
src\components\providers\forms\CodexConfigSections.tsx|6
src\components\proxy\ProxyToggle.tsx|6
src\hooks\useLastValidValue.ts|6
src\components\usage\ModelStatsTable.tsx|6
src\components\providers\forms\BasicFormFields.tsx|6
src\components\providers\forms\hooks\useApiKeyLink.ts|6
src\components\providers\forms\GeminiConfigSections.tsx|6
src\utils\uuid.ts|6
src\lib\userAgent.ts|6
src\config\constants.ts|6
src\components\codex\HostedToolsSwitchPanel.tsx|6
src\components\usage\UsageDateRangePicker.tsx|6
src\components\providers\forms\shared\ApiKeySection.tsx|5
src\types\icon.ts|5
src\components\settings\AuthCenterPanel.tsx|5
src\components\usage\ProviderStatsTable.tsx|5
src\components\providers\forms\shared\ModelInputWithFetch.tsx|5
src\components\usage\ConnectivityCheckConfigPanel.tsx|5
src\hooks\useSettingsMetadata.ts|5
src\components\proxy\FailoverToggle.tsx|5
src\components\providers\forms\hooks\useProviderCategory.ts|5
src\utils\deepClone.ts|5
src\hooks\useDragSort.ts|5
src\components\profiles\scope.ts|5
src\lib\query\usage.ts|5
src\components\XaiOauthQuotaFooter.tsx|5
src\components\CodexOauthQuotaFooter.tsx|4
src\icons\extracted\metadata.ts|4
src\i18n\index.ts|4
src\hooks\useSkills.helpers.ts|4
src\components\providers\forms\CommonConfigEditor.tsx|4
src\config\codexTemplates.ts|4
src\components\providers\forms\shared\EndpointField.tsx|4
src\components\providers\forms\CodexConfigEditor.tsx|4
src\components\CopilotQuotaFooter.tsx|4
src\components\ConfirmDialog.tsx|4
src\components\profiles\ProfileManageDialog.tsx|3
src\components\proxy\ClaudeDesktopRouteToggle.tsx|3
src\lib\authBinding.ts|3
src\components\sessions\SessionMessageItem.tsx|3
src\components\settings\LanguageSwitcher.tsx|3
src\components\providers\FailoverPriorityBadge.tsx|3
src\hooks\useUsageCacheBridge.ts|3
src\components\FirstRunNoticeDialog.tsx|3
src\components\FrontendErrorBoundary.tsx|3
src\hooks\usePromptActions.ts|3
src\components\ui\layers.ts|3
src\components\usage\RequestLogTable.tsx|3
src\components\settings\ToolUpgradeConfirmDialog.tsx|3
src\components\providers\forms\GeminiCommonConfigModal.tsx|3
src\components\ui\dialog.tsx|3
src\components\skills\RepoManagerPanel.tsx|3
src\hooks\useSessionSearch.ts|2
src\hooks\useDebouncedValue.ts|2
src\components\providers\forms\hooks\useManagedAuth.ts|2
src\hooks\useTauriEvent.ts|2
src\components\settings\LogConfigPanel.tsx|2
src\components\providers\forms\hooks\useCodexOauth.ts|2
src\lib\usageRange.ts|2
src\hooks\useCodexLocalRoutingNotice.ts|2
src\components\ui\sonner.tsx|2
src\components\settings\WebdavSyncSection.tsx|2
src\components\settings\ToolInstallRow.tsx|2
src\components\prompts\PromptToggle.tsx|2
src\lib\api\subscription.ts|2
src\components\providers\forms\codexReasoningCapability.ts|2
src\components\settings\DirectorySettings.tsx|2
src\utils\postChangeSync.ts|2
src\components\env\EnvWarningBanner.tsx|2
src\components\providers\ProviderEmptyState.tsx|1
src\components\prompts\PromptListItem.tsx|1
src\components\sessions\SessionItem.tsx|1
src\components\BrandIcons.tsx|1
src\components\sessions\utils.ts|1
src\components\settings\SkillStorageLocationSettings.tsx|1
src\lib\api\types.ts|1
src\components\settings\ProxyTabContent.tsx|1
src\components\prompts\PromptPanel.tsx|1
src\lib\query\copilot.ts|1
src\components\proxy\index.ts|1
src\components\skills\UnifiedSkillsPanel.tsx|1

