# Android keyboard and composer regression

## Report and change

On the Pixel 8a running GrapheneOS, focusing the message input in Perch 0.5.0 opened the keyboard over the composer. The typed text was covered. The native thread and input sheets used an explicit keyboard-avoidance behavior only on iOS.

Both now use `height` on Android and retain `padding` on iOS. The thread retains its measured offset for the header and the bottom inset already provided by its footer. The Android manifest already requests `adjustResize`; the app also enables edge-to-edge display. The fix handles a full-height window where resize alone does not move the composer. No dependency, Android permission, or runtime version changed.

React Native 0.86 [recommends setting `behavior` on both platforms](https://reactnative.dev/docs/0.86/keyboardavoidingview). The [Expo keyboard guide](https://docs.expo.dev/guides/keyboard-handling/) explains that the appropriate behavior depends on the screen and platform. Its basic example relies on Android window resizing, which is insufficient for the reported full-height layout.

## Executable regression

```sh
node scripts/verify-keyboard.cjs
```

This command loads the installed React Native `KeyboardAvoidingView` implementation. It reads the actual JSX properties from Perch's thread and sheet, supplies native keyboard and layout events, and checks the resulting styles at the component's native-renderer boundary. React state updates, platform services, and native `View` construction are controlled by the harness; the React Native event handling, overlap calculation, and rendered height or padding run unchanged.

Before the change, the thread case failed:

```text
Android edge-to-edge portrait: composer bottom 860px is hidden below keyboard top 560px
```

The sheet case independently failed with its form bottom at 856px and keyboard top at 560px. Both pass after the behavior change.

The five scenarios cover Android portrait, Android landscape, an Android window already resized by the operating system, iOS with a header and home indicator, and the Android input sheet. Assertions cover visibility above the keyboard, avoiding a duplicated keyboard inset, stable layout feedback, increased keyboard-panel height, and restoration after dismissal. TypeScript also passed after the change.

These are deterministic component-layout checks. Their geometry is a synthetic fixture, not a measurement from the user's Pixel. They do not prove native painting, focus, keyboard animation, live rotation, or the input method's reported coordinates.

## Device check

The existing smoke flow now checks typed text and the Send control **before** hiding the keyboard. It also records an open-keyboard screenshot. The focused flow covers a new chat, keyboard dismissal and reopening, and an existing chat:

```sh
node tooling/run.mjs maestro test .maestro/keyboard.yml
```

Like the other demo device flows, this clears Perch app data. Use a standalone prototype installation intended for testing. It makes no model calls and does not connect a host.

Inspect the three `artifacts/device/keyboard-*` screenshots while the keyboard is open. Confirm that the whole input and Send control remain above the keyboard. Also check a multi-line draft, a taller emoji keyboard, gesture navigation, and changing orientation. Accessibility visibility assertions alone cannot establish whether another native window covers a control, so the screenshots and device observation remain part of this check.

The execution workspace had no attached Android device, emulator binary, or `/dev/kvm`. The device flow was prepared but not executed there. Android's standard React Native keyboard API supplies [`keyboardDidShow` and `keyboardDidHide`](https://reactnative.dev/docs/0.86/keyboard); smooth tracking during every frame of the keyboard animation remains a separate native-device check.
