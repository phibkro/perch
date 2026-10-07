# Native assistant-ui elements

Copied from assistant-ui/assistant-ui at commit `78557063f8b70c540ca0b1e07eca5cc4fe0216d7` (MIT).

These are the actual React Native registry elements and their source dependencies. Perch supplies its session adapter and message/composer slots in the parent directory.

Perch 0.3 adapts `thread.aui.tsx` presentation: the empty welcome has its own flexible scroll area and the composer stays docked at the bottom, matching populated conversations. The loading view also reserves that space. Runtime, message-list, keyboard, and composer primitives remain the upstream implementation.
