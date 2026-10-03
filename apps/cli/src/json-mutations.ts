import type { AgentWorkspaceClient } from '@agent-workspace/client-runtime'
import {
  workspaceSelectRequestSchema,
  workspaceMoveRequestSchema,
  workspaceUpdateRequestSchema,
  workspaceCreateRequestSchema,
  workspaceCloseRequestSchema,
  workspacePinRequestSchema,
  workspaceSelectionReplaceRequestSchema,
  workspaceCanonicalMoveRequestSchema,
  workspaceBatchCloseRequestSchema,
  tabSelectRequestSchema,
  tabOpenTerminalRequestSchema,
  tabOpenBrowserRequestSchema,
  tabCloseRequestSchema,
  tabMoveRequestSchema,
  tabUpdateRequestSchema,
  paneFocusRequestSchema,
  paneResizeRequestSchema,
  paneSplitRequestSchema,
  paneCloseRequestSchema,
  groupCreateRequestSchema,
  groupRenameRequestSchema,
  groupDeleteRequestSchema,
  groupMoveRequestSchema,
  groupAssignRequestSchema,
  groupCollapseRequestSchema,
  layoutSaveRequestSchema,
  layoutDeleteRequestSchema,
  layoutApplyRequestSchema,
  layoutImportRequestSchema,
  terminalRestartRequestSchema,
  sidebarSaveParamsSchema,
  textBoxCreateParamsSchema,
  textBoxSaveParamsSchema,
  textBoxDeleteParamsSchema,
  agentTeamCreateParamsSchema,
  agentTeamUpdateParamsSchema,
  agentTeamDeleteParamsSchema,
  agentTeamMemberCreateParamsSchema,
  agentTeamMemberUpdateParamsSchema,
  agentTeamMemberMoveParamsSchema,
  agentTeamMemberDeleteParamsSchema,
  agentCatalogRegisterParamsSchema,
  agentRestoreAssessParamsSchema,
  agentSessionRestoreParamsSchema,
  agentSessionForkParamsSchema,
  agentAttentionSetParamsSchema,
  agentHibernationPreflightParamsSchema,
  agentHibernationCancelParamsSchema,
  agentHibernationConfirmParamsSchema,
  workspaceCardSlotsSnapshotParamsSchema,
  workspaceCardSlotsReplaceParamsSchema,
  workspaceCardSlotV2GetParamsSchema,
  workspaceCardSlotV2ReplaceParamsSchema,
  workspaceAttentionSnapshotParamsSchema,
  attentionAcknowledgementParamsSchema,
  notificationWriteRequestSchema,
  notificationPublishRequestSchema,
  notificationClearRequestSchema,
  settingsWriteRequestSchema,
  settingsResetRequestSchema,
  tabReopenRequestSchema,
  actionInvokeParamsSchema,
  actionCancelParamsSchema
} from '@agent-workspace/contracts'

type Mutation = (client: AgentWorkspaceClient, params: unknown) => Promise<unknown>

/** Contract-checked access to Node capabilities whose CLI syntax has no dedicated flags yet. */
const mutations: Record<string, Mutation> = {
  'action.invoke': (client, params) => client.invokeAction(actionInvokeParamsSchema.parse(params)),
  'action.cancel': (client, params) => client.cancelAction(actionCancelParamsSchema.parse(params)),
  'workspace.select': (client, params) =>
    client.selectWorkspace(workspaceSelectRequestSchema.parse(params)),
  'workspace.move': (client, params) =>
    client.moveWorkspace(workspaceMoveRequestSchema.parse(params)),
  'workspace.update': (client, params) =>
    client.updateWorkspace(workspaceUpdateRequestSchema.parse(params)),
  'workspace.create': (client, params) =>
    client.createWorkspace(workspaceCreateRequestSchema.parse(params)),
  'workspace.close': (client, params) =>
    client.closeWorkspace(workspaceCloseRequestSchema.parse(params)),
  'workspace.pin': (client, params) => client.pinWorkspace(workspacePinRequestSchema.parse(params)),
  'workspace.selectMany': (client, params) =>
    client.selectWorkspaces(workspaceSelectionReplaceRequestSchema.parse(params)),
  'workspace.reorder': (client, params) =>
    client.reorderWorkspace(workspaceCanonicalMoveRequestSchema.parse(params)),
  'workspace.closeSelected': (client, params) =>
    client.closeSelectedWorkspaces(workspaceBatchCloseRequestSchema.parse(params)),
  'tab.select': (client, params) => client.selectTab(tabSelectRequestSchema.parse(params)),
  'tab.openTerminal': (client, params) =>
    client.openTerminalTab(tabOpenTerminalRequestSchema.parse(params)),
  'tab.openBrowser': (client, params) =>
    client.openBrowserTab(tabOpenBrowserRequestSchema.parse(params)),
  'tab.close': (client, params) => client.closeTab(tabCloseRequestSchema.parse(params)),
  'tab.reopen': (client, params) =>
    client.reopenClosedTabPrivileged(tabReopenRequestSchema.parse(params)),
  'tab.move': (client, params) => client.moveTab(tabMoveRequestSchema.parse(params)),
  'tab.update': (client, params) => client.updateTab(tabUpdateRequestSchema.parse(params)),
  'pane.focus': (client, params) => client.focusPane(paneFocusRequestSchema.parse(params)),
  'pane.resize': (client, params) => client.resizePane(paneResizeRequestSchema.parse(params)),
  'pane.split': (client, params) => client.splitPane(paneSplitRequestSchema.parse(params)),
  'pane.close': (client, params) => client.closePane(paneCloseRequestSchema.parse(params)),
  'group.create': (client, params) => client.createGroup(groupCreateRequestSchema.parse(params)),
  'group.rename': (client, params) => client.renameGroup(groupRenameRequestSchema.parse(params)),
  'group.delete': (client, params) => client.deleteGroup(groupDeleteRequestSchema.parse(params)),
  'group.move': (client, params) => client.moveGroup(groupMoveRequestSchema.parse(params)),
  'group.assign': (client, params) => client.assignGroup(groupAssignRequestSchema.parse(params)),
  'group.collapse': (client, params) =>
    client.collapseGroup(groupCollapseRequestSchema.parse(params)),
  'layout.save': (client, params) => client.saveLayout(layoutSaveRequestSchema.parse(params)),
  'layout.delete': (client, params) => client.deleteLayout(layoutDeleteRequestSchema.parse(params)),
  'layout.apply': (client, params) => client.applyLayout(layoutApplyRequestSchema.parse(params)),
  'layout.import': (client, params) => client.importLayout(layoutImportRequestSchema.parse(params)),
  'terminal.restart': (client, params) =>
    client.restartTerminal(terminalRestartRequestSchema.parse(params)),
  'sidebar.placement.save': (client, params) =>
    client.saveSidebarPlacement(sidebarSaveParamsSchema.parse(params)),
  'textbox.create': (client, params) =>
    client.createTextBox(textBoxCreateParamsSchema.parse(params)),
  'textbox.save': (client, params) => client.saveTextBox(textBoxSaveParamsSchema.parse(params)),
  'textbox.delete': (client, params) =>
    client.deleteTextBox(textBoxDeleteParamsSchema.parse(params)),
  'agent.team.create': (client, params) =>
    client.createAgentTeam(agentTeamCreateParamsSchema.parse(params)),
  'agent.catalog.register': (client, params) =>
    client.registerAgentSession(agentCatalogRegisterParamsSchema.parse(params)),
  'agent.restore.assess': (client, params) =>
    client.assessAgentRestore(agentRestoreAssessParamsSchema.parse(params)),
  'agent.session.restore': (client, params) =>
    client.restoreAgentSession(agentSessionRestoreParamsSchema.parse(params)),
  'agent.session.fork': (client, params) =>
    client.forkAgentSession(agentSessionForkParamsSchema.parse(params)),
  'agent.attention.set': (client, params) =>
    client.setAgentAttention(agentAttentionSetParamsSchema.parse(params)),
  'agent.hibernate.preflight': (client, params) =>
    client.preflightAgentHibernation(agentHibernationPreflightParamsSchema.parse(params)),
  'agent.hibernate.confirm': (client, params) =>
    client.confirmAgentHibernation(agentHibernationConfirmParamsSchema.parse(params)),
  'agent.hibernate.cancel': (client, params) =>
    client.cancelAgentHibernation(agentHibernationCancelParamsSchema.parse(params)),
  'workspace.cardSlots.get': (client, params) =>
    client.getWorkspaceCardSlots(workspaceCardSlotsSnapshotParamsSchema.parse(params).workspaceId),
  'workspace.cardSlots.replace': (client, params) =>
    client.replaceWorkspaceCardSlots(workspaceCardSlotsReplaceParamsSchema.parse(params)),
  'workspace.cardSlots.v2.get': (client, params) => {
    const { workspaceId, kind } = workspaceCardSlotV2GetParamsSchema.parse(params)
    return client.getWorkspaceCardSlotV2(workspaceId, kind)
  },
  'workspace.cardSlots.v2.replace': (client, params) =>
    client.replaceWorkspaceCardSlotV2(workspaceCardSlotV2ReplaceParamsSchema.parse(params)),
  'workspace.attention.get': (client, params) =>
    client.getWorkspaceAttention(workspaceAttentionSnapshotParamsSchema.parse(params).workspaceId),
  'attention.acknowledge': (client, params) =>
    client.acknowledgeAttention(attentionAcknowledgementParamsSchema.parse(params)),
  'agent.team.update': (client, params) =>
    client.updateAgentTeam(agentTeamUpdateParamsSchema.parse(params)),
  'agent.team.delete': (client, params) =>
    client.deleteAgentTeam(agentTeamDeleteParamsSchema.parse(params)),
  'agent.team.member.create': (client, params) =>
    client.createAgentTeamMember(agentTeamMemberCreateParamsSchema.parse(params)),
  'agent.team.member.update': (client, params) =>
    client.updateAgentTeamMember(agentTeamMemberUpdateParamsSchema.parse(params)),
  'agent.team.member.move': (client, params) =>
    client.moveAgentTeamMember(agentTeamMemberMoveParamsSchema.parse(params)),
  'agent.team.member.delete': (client, params) =>
    client.deleteAgentTeamMember(agentTeamMemberDeleteParamsSchema.parse(params)),
  'notification.markRead': (client, params) =>
    client.markNotificationRead(notificationWriteRequestSchema.parse(params)),
  'notification.publish': (client, params) =>
    client.publishNotification(notificationPublishRequestSchema.parse(params)),
  'notification.markUnread': (client, params) =>
    client.markNotificationUnread(notificationWriteRequestSchema.parse(params)),
  'notification.clear': (client, params) =>
    client.clearNotifications(notificationClearRequestSchema.parse(params)),
  'settings.update': (client, params) =>
    client.updateSettings(settingsWriteRequestSchema.parse(params)),
  'settings.resetKey': (client, params) =>
    client.resetShortcut(settingsResetRequestSchema.parse(params))
}

export function supportsJsonMutation(capability: string): boolean {
  return Object.hasOwn(mutations, capability)
}

export function runJsonMutation(client: AgentWorkspaceClient, capability: string, params: unknown) {
  const mutation = mutations[capability]
  if (!mutation) throw new Error(`Unsupported JSON mutation: ${capability}`)
  return mutation(client, params)
}
