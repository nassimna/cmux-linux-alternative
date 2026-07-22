import { useEffect, useRef, useState } from 'react'

import type { ConfigurationSnapshot, ConfigurationUpdate } from '@agent-workspace/protocol-client'

import type { DesktopUpdateState } from '../../../shared/desktop-bridge'
import { useConfigurationStore } from '../configuration-store'
import { messages } from '../messages'
import { Button } from '../ui/button'

interface ConfigurationSettingsProps {
  activeSection: ConfigurationSettingsSection
  configurationV2: boolean
  open: boolean
}

export type ConfigurationSettingsSection =
  'appearance' | 'terminal' | 'notifications' | 'updates' | 'advanced'

export function ConfigurationSettings({
  activeSection,
  configurationV2,
  open
}: ConfigurationSettingsProps): React.JSX.Element {
  const config = useConfigurationStore((state) => state.config)
  const configurationStatus = useConfigurationStore((state) => state.status)
  const [draft, setDraft] = useState<ConfigurationSnapshot | null>(null)
  const draftRef = useRef<ConfigurationSnapshot | null>(null)
  const themeSelectRef = useRef<HTMLSelectElement | null>(null)
  const densitySelectRef = useRef<HTMLSelectElement | null>(null)
  const fontFamilyInputRef = useRef<HTMLInputElement | null>(null)
  const loggingSelectRef = useRef<HTMLSelectElement | null>(null)
  const updateChannelSelectRef = useRef<HTMLSelectElement | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null)

  useEffect(() => {
    if (!open) return
    void useConfigurationStore.getState().initialize(window.desktopBridge)
  }, [open])

  useEffect(() => {
    if (!open || !config) return
    queueMicrotask(() => {
      const next = structuredClone(config)
      draftRef.current = next
      setDraft(next)
    })
  }, [config, open])

  const adoptDraft = (next: ConfigurationSnapshot): void => {
    draftRef.current = next
    setDraft(next)
  }

  const updateDraft = (update: (current: ConfigurationSnapshot) => ConfigurationSnapshot): void => {
    const current = draftRef.current
    if (!current) return
    adoptDraft(update(current))
  }

  useEffect(() => {
    if (!open) return
    const bridge = window.desktopBridge
    let active = true
    const remove = bridge.onUpdateState?.((state) => {
      if (active) setUpdateState(state)
    })
    if (bridge.getUpdateState) {
      void bridge
        .getUpdateState()
        .then((state) => {
          if (active) setUpdateState(state)
        })
        .catch(() => {
          if (active) setStatus(messages.settings.updater.actionFailed)
        })
    }
    return () => {
      active = false
      remove?.()
    }
  }, [open])

  const saveSection = async (
    section: keyof ConfigurationUpdate,
    createUpdate: (current: ConfigurationSnapshot) => ConfigurationUpdate
  ): Promise<void> => {
    const bridge = window.desktopBridge
    const currentConfig = useConfigurationStore.getState().config
    const currentDraft = draftRef.current
    if (!currentConfig || !currentDraft || !bridge.updateConfiguration || saving !== null) return
    setSaving(section)
    setStatus(null)
    try {
      const result = await bridge.updateConfiguration({
        expectedRevision: currentConfig.revision,
        update: createUpdate(currentDraft)
      })
      useConfigurationStore.getState().apply(result.config)
      adoptDraft(structuredClone(result.config))
      setStatus(messages.settings.saved)
    } catch (error) {
      const latest = await useConfigurationStore.getState().refresh()
      if (latest) adoptDraft(structuredClone(latest))
      setStatus(
        error instanceof Error && /conflict|revision|stale/iu.test(error.message)
          ? messages.settings.conflict
          : messages.settings.saveFailed
      )
    } finally {
      setSaving(null)
    }
  }

  const runUpdateAction = async (
    action: 'checkForUpdate' | 'downloadUpdate' | 'installUpdate'
  ): Promise<void> => {
    const operation = window.desktopBridge[action]
    if (!operation) return
    setStatus(null)
    try {
      const result = await operation()
      if (result) setUpdateState(result)
    } catch {
      setStatus(messages.settings.updater.actionFailed)
    }
  }

  if (!draft) {
    const unavailable = configurationStatus === 'unavailable'
    const failed = configurationStatus === 'error'
    return status ? (
      <p className="configuration-status" role="status">
        {status}
      </p>
    ) : (
      <p className="configuration-status" role="status">
        {unavailable
          ? messages.settings.configurationUnavailable
          : failed
            ? messages.settings.loadFailed
            : messages.settings.loading}
      </p>
    )
  }

  return (
    <div className="configuration-settings">
      {status ? (
        <p className="configuration-status" role="status">
          {status}
        </p>
      ) : null}
      <SettingsSection
        activeSection={activeSection}
        section="appearance"
        title={messages.settings.appearance}
      >
        <Field label={messages.settings.fields.theme}>
          <select
            ref={themeSelectRef}
            onChange={(event) =>
              updateDraft((current) => ({
                ...current,
                appearance: {
                  ...current.appearance,
                  theme: event.currentTarget.value as never
                }
              }))
            }
            value={draft.appearance.theme}
          >
            <option value="system">{messages.settings.options.system}</option>
            <option value="dark">{messages.settings.options.dark}</option>
            <option value="light">{messages.settings.options.light}</option>
          </select>
        </Field>
        <Field label={messages.settings.fields.density}>
          <select
            ref={densitySelectRef}
            onChange={(event) =>
              updateDraft((current) => ({
                ...current,
                appearance: {
                  ...current.appearance,
                  density: event.currentTarget.value as never
                }
              }))
            }
            value={draft.appearance.density}
          >
            <option value="comfortable">{messages.settings.options.comfortable}</option>
            <option value="compact">{messages.settings.options.compact}</option>
            {configurationV2 ? (
              <option value="expanded">{messages.settings.options.expanded}</option>
            ) : null}
          </select>
        </Field>
        <Field label={messages.settings.fields.interfaceFontFamily}>
          <input
            autoComplete="off"
            ref={fontFamilyInputRef}
            onChange={(event) =>
              updateDraft((current) => ({
                ...current,
                appearance: {
                  ...current.appearance,
                  fontFamily: event.currentTarget.value
                }
              }))
            }
            spellCheck={false}
            value={draft.appearance.fontFamily}
          />
        </Field>
        <DeferredNotice>{messages.settings.interfaceFontBehavior}</DeferredNotice>
        <SectionSave
          busy={saving === 'appearance'}
          onClick={() =>
            void saveSection('appearance', (current) => ({
              appearance: {
                theme: (themeSelectRef.current?.value ??
                  current.appearance.theme) as ConfigurationSnapshot['appearance']['theme'],
                density: (densitySelectRef.current?.value ??
                  current.appearance.density) as ConfigurationSnapshot['appearance']['density'],
                fontFamily: fontFamilyInputRef.current?.value ?? current.appearance.fontFamily
              }
            }))
          }
        />
      </SettingsSection>

      <SettingsSection
        activeSection={activeSection}
        section="terminal"
        title={messages.settings.terminal}
      >
        <Field label={messages.settings.fields.shellPath}>
          <input
            autoComplete="off"
            onChange={(event) =>
              updateDraft((current) => ({
                ...current,
                terminal: {
                  ...current.terminal,
                  shellPath: event.currentTarget.value || null
                }
              }))
            }
            placeholder={messages.settings.fields.shellPlaceholder}
            spellCheck={false}
            value={draft.terminal.shellPath ?? ''}
          />
        </Field>
        <DeferredNotice>{messages.settings.shellBehavior}</DeferredNotice>
        <Field label={messages.settings.fields.fontFamily}>
          <input
            onChange={(event) =>
              updateDraft((current) => ({
                ...current,
                terminal: { ...current.terminal, fontFamily: event.currentTarget.value }
              }))
            }
            value={draft.terminal.fontFamily}
          />
        </Field>
        <Field label={messages.settings.fields.fontSize}>
          <input
            max={72}
            min={6}
            onChange={(event) =>
              updateDraft((current) => ({
                ...current,
                terminal: { ...current.terminal, fontSize: event.currentTarget.valueAsNumber }
              }))
            }
            type="number"
            value={draft.terminal.fontSize}
          />
        </Field>
        <Field label={messages.settings.fields.scrollback}>
          <input
            max={1_000_000}
            min={100}
            onChange={(event) =>
              updateDraft((current) => ({
                ...current,
                terminal: { ...current.terminal, scrollback: event.currentTarget.valueAsNumber }
              }))
            }
            type="number"
            value={draft.terminal.scrollback}
          />
        </Field>
        <CheckField
          checked={draft.terminal.multilinePasteProtection}
          label={messages.settings.fields.multilinePaste}
          onChange={(checked) =>
            updateDraft((current) => ({
              ...current,
              terminal: { ...current.terminal, multilinePasteProtection: checked }
            }))
          }
        />
        <SectionSave
          busy={saving === 'terminal'}
          onClick={() =>
            void saveSection('terminal', (current) => ({ terminal: current.terminal }))
          }
        />
      </SettingsSection>

      <SettingsSection
        activeSection={activeSection}
        note={messages.settings.deferred.browser}
        section="advanced"
        title={messages.settings.browser}
      >
        <Field label={messages.settings.fields.profileName}>
          <input disabled value={draft.browser.profileName} />
        </Field>
        <Field label={messages.settings.fields.profilePartition}>
          <input disabled value={draft.browser.partition} />
        </Field>
        <Field label={messages.settings.fields.privacy}>
          <select disabled value={draft.browser.privacy}>
            <option value="standard">{messages.settings.options.standard}</option>
            <option value="strict">{messages.settings.options.strict}</option>
          </select>
        </Field>
      </SettingsSection>

      <SettingsSection
        activeSection={activeSection}
        section="notifications"
        title={messages.settings.notifications}
      >
        <CheckField
          checked={draft.notifications.systemEnabled}
          label={messages.settings.fields.systemNotifications}
          onChange={(systemEnabled) =>
            updateDraft((current) => ({
              ...current,
              notifications: { ...current.notifications, systemEnabled }
            }))
          }
        />
        <CheckField
          checked={draft.notifications.includeBody}
          disabled={!draft.notifications.systemEnabled}
          label={messages.settings.fields.notificationBody}
          onChange={(includeBody) =>
            updateDraft((current) => ({
              ...current,
              notifications: { ...current.notifications, includeBody }
            }))
          }
        />
        <SectionSave
          busy={saving === 'notifications'}
          onClick={() =>
            void saveSection('notifications', (current) => ({
              notifications: current.notifications
            }))
          }
        />
      </SettingsSection>

      <SettingsSection
        activeSection={activeSection}
        note={messages.settings.deferred.agents}
        section="advanced"
        title={messages.settings.agents}
      >
        <CheckField
          checked={draft.agentIntegration.enabled}
          disabled
          label={messages.settings.fields.enableAgents}
        />
        <CheckField
          checked={draft.agentIntegration.notificationsEnabled}
          disabled
          label={messages.settings.fields.agentNotifications}
        />
        <CheckField
          checked={draft.agentIntegration.browserEnabled}
          disabled
          label={messages.settings.fields.agentBrowser}
        />
      </SettingsSection>

      <SettingsSection
        activeSection={activeSection}
        section="advanced"
        title={messages.settings.logging}
      >
        <Field label={messages.settings.fields.logLevel}>
          <select
            ref={loggingSelectRef}
            onChange={(event) =>
              updateDraft((current) => ({
                ...current,
                logging: { level: event.currentTarget.value as typeof current.logging.level }
              }))
            }
            value={draft.logging.level}
          >
            <option value="error">{messages.settings.options.error}</option>
            <option value="warn">{messages.settings.options.warn}</option>
            <option value="info">{messages.settings.options.info}</option>
            <option value="debug">{messages.settings.options.debug}</option>
            <option value="trace">{messages.settings.options.trace}</option>
          </select>
        </Field>
        <DeferredNotice>{messages.settings.loggingBehavior}</DeferredNotice>
        <SectionSave
          busy={saving === 'logging'}
          onClick={() =>
            void saveSection('logging', (current) => ({
              logging: {
                level: (loggingSelectRef.current?.value ??
                  current.logging.level) as ConfigurationSnapshot['logging']['level']
              }
            }))
          }
        />
      </SettingsSection>

      <SettingsSection
        activeSection={activeSection}
        note={messages.settings.deferred.updates}
        section="updates"
        title={messages.settings.updates}
      >
        <Field label={messages.settings.fields.updateChannel}>
          <select
            ref={updateChannelSelectRef}
            onChange={(event) =>
              updateDraft((current) => ({
                ...current,
                updates: { channel: event.currentTarget.value as 'stable' | 'beta' }
              }))
            }
            value={draft.updates.channel}
          >
            <option value="stable">{messages.settings.options.stable}</option>
            <option value="beta">{messages.settings.options.beta}</option>
          </select>
        </Field>
        <SectionSave
          busy={saving === 'updates'}
          onClick={() =>
            void saveSection('updates', (current) => ({
              updates: {
                channel: (updateChannelSelectRef.current?.value ??
                  current.updates.channel) as ConfigurationSnapshot['updates']['channel']
              }
            }))
          }
        />
        {updateState ? (
          <div className="configuration-update-status" role="status">
            {updateStateMessage(updateState)}
          </div>
        ) : null}
        <div className="configuration-update-actions">
          {updateState &&
          (updateState.status === 'idle' ||
            updateState.status === 'up-to-date' ||
            updateState.status === 'error') ? (
            <Button onClick={() => void runUpdateAction('checkForUpdate')} size="small">
              {messages.settings.updater.check}
            </Button>
          ) : null}
          {updateState?.status === 'available' ? (
            <Button onClick={() => void runUpdateAction('downloadUpdate')} size="small">
              {messages.settings.updater.download}
            </Button>
          ) : null}
          {updateState?.status === 'downloaded' ? (
            <Button onClick={() => void runUpdateAction('installUpdate')} size="small">
              {messages.settings.updater.install}
            </Button>
          ) : null}
        </div>
      </SettingsSection>
    </div>
  )
}

function updateStateMessage(state: DesktopUpdateState): string {
  const copy = messages.settings.updater
  switch (state.status) {
    case 'unconfigured':
      return copy.unconfigured
    case 'development':
      return copy.development
    case 'unsupported':
      return copy.unsupported
    case 'idle':
      return copy.idle
    case 'checking':
      return copy.checking
    case 'up-to-date':
      return copy.upToDate
    case 'available':
      return `${copy.available} ${state.version}`
    case 'downloading':
      return `${copy.downloading}: ${state.progress.toFixed(0)}%`
    case 'downloaded':
      return copy.downloaded
    case 'error':
      return state.message
  }
}

function SettingsSection({
  activeSection,
  children,
  note,
  section,
  title
}: {
  activeSection: ConfigurationSettingsSection
  children: React.ReactNode
  note?: string
  section: ConfigurationSettingsSection
  title: string
}): React.JSX.Element {
  return (
    <section className="configuration-section" hidden={activeSection !== section}>
      <h3>{title}</h3>
      {note ? <DeferredNotice>{note}</DeferredNotice> : null}
      <div className="configuration-fields">{children}</div>
    </section>
  )
}

function Field({
  children,
  label
}: {
  children: React.ReactNode
  label: string
}): React.JSX.Element {
  return (
    <label className="configuration-field">
      <span>{label}</span>
      {children}
    </label>
  )
}

function CheckField({
  checked,
  disabled = false,
  label,
  onChange = () => undefined
}: {
  checked: boolean
  disabled?: boolean
  label: string
  onChange?: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <label className="configuration-check">
      <input
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
      <span>{label}</span>
    </label>
  )
}

function DeferredNotice({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="configuration-deferred">{children}</p>
}

function SectionSave({ busy, onClick }: { busy: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <Button disabled={busy} onClick={onClick} size="small">
      {busy ? messages.settings.saving : messages.settings.saveSection}
    </Button>
  )
}
