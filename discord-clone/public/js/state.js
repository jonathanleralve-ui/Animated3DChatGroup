// Small shared mutable state object. Every other frontend module reads/writes
// through this instead of holding its own copies, so there's one source of truth.
const AppState = {
  token: localStorage.getItem('chatter_token') || null,
  me: null,
  socket: null,

  friendsData: { friends: [], incoming: [], outgoing: [] },
  elseData: [],
  groupsData: [],

  // The group currently open in the sidebar (null when on the Friends home screen)
  activeGroup: null,
  // Channels of the currently open group: [{ id, groupId, name, type, category, position }]
  activeGroupChannels: [],

  // Currently open chat in the main pane: { type: 'dm'|'channel', id, name, color?, groupId? }
  activeChat: null,
  activeMemberIds: [],

  // Who's currently connected to each voice channel of the open group, keyed
  // by channel id: { [channelId]: [{ userId, displayName, avatarColor, avatarUrl, nameColor, sharing }] }
  voiceRosters: {},
  // ms epoch timestamp of when each voice channel's current call started
  // (i.e. when it went from 0 to 1 participant), keyed by channel id. Absent/
  // null means that channel has nobody in it right now. Cleared server-side
  // the moment a channel empties back out, so a later call gets its own
  // fresh start time rather than resuming the old one.
  voiceCallStartedAt: {},

  // Unread-message tracking for the rail's red dots. unreadGroupIds maps
  // groupId -> true for groups with an unseen channel message; unreadDmSenders
  // maps userId -> true for friends with an unseen DM. Both are runtime-only
  // (reset on page reload) — there's no persisted "last read" state.
  unreadGroupIds: {},
  unreadChannelIds: {},
  unreadDmSenders: {},

  unreadFriendsTabSenders: {},
  unreadElseTabSenders: {},
  seenIncomingRequestIds: null
};