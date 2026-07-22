import { create } from 'zustand'

import type { ConfigurationSnapshot } from '@agent-workspace/protocol-client'

import type { DesktopBridge } from '../../shared/desktop-bridge'

type ConfigurationStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'

interface ConfigurationState {
  config: ConfigurationSnapshot | null
  error: string | null
  status: ConfigurationStatus
  apply(config: ConfigurationSnapshot): void
  initialize(bridge: DesktopBridge): Promise<void>
  reinitialize(bridge: DesktopBridge): Promise<void>
  refresh(): Promise<ConfigurationSnapshot | null>
}

let activeBridge: DesktopBridge | undefined
let initialization: Promise<void> | undefined
let generation = 0

export const useConfigurationStore = create<ConfigurationState>((set, get) => ({
  config: null,
  error: null,
  status: 'idle',
  apply: (config) => set({ config, error: null, status: 'ready' }),
  initialize: async (bridge) => {
    activeBridge = bridge
    if (initialization) return initialization
    if (get().status === 'ready') return
    if (!bridge.getConfiguration) {
      set({ status: 'unavailable', error: null })
      return
    }

    const currentGeneration = generation
    set({ status: 'loading', error: null })
    initialization = bridge
      .getConfiguration()
      .then(({ config }) => {
        if (generation === currentGeneration) set({ config, status: 'ready', error: null })
      })
      .catch((error: unknown) => {
        if (generation !== currentGeneration) return
        set({
          status: 'error',
          error: error instanceof Error ? error.message : 'Configuration could not be loaded.'
        })
      })
      .finally(() => {
        if (generation === currentGeneration) initialization = undefined
      })
    return initialization
  },
  reinitialize: async (bridge) => {
    const currentGeneration = ++generation
    activeBridge = bridge
    initialization = undefined
    if (!bridge.getConfiguration) {
      set({ config: null, status: 'unavailable', error: null })
      return
    }

    set({ status: 'loading', error: null })
    const operation = bridge
      .getConfiguration()
      .then(({ config }) => {
        if (generation === currentGeneration) set({ config, status: 'ready', error: null })
      })
      .catch((error: unknown) => {
        if (generation !== currentGeneration) return
        set({
          status: 'error',
          error: error instanceof Error ? error.message : 'Configuration could not be loaded.'
        })
      })
      .finally(() => {
        if (generation === currentGeneration && initialization === operation) {
          initialization = undefined
        }
      })
    initialization = operation
    return operation
  },
  refresh: async () => {
    const bridge = activeBridge
    if (!bridge?.getConfiguration) return null
    const currentGeneration = generation
    try {
      const { config } = await bridge.getConfiguration()
      if (generation !== currentGeneration) return null
      set({ config, status: 'ready', error: null })
      return config
    } catch (error) {
      if (generation === currentGeneration) {
        set({
          error: error instanceof Error ? error.message : 'Configuration could not be loaded.'
        })
      }
      return null
    }
  }
}))

export function resetConfigurationStoreForTests(): void {
  generation += 1
  activeBridge = undefined
  initialization = undefined
  useConfigurationStore.setState({ config: null, error: null, status: 'idle' })
  delete document.documentElement.dataset.density
  delete document.documentElement.dataset.theme
  document.documentElement.style.removeProperty('--aw-font-ui')
}
