import React from 'react';
import { Button, Host, Switch, Text } from '@expo/ui';
import type { Theme } from './theme';

/** An actual Compose button on Android and SwiftUI button on iOS. */
export function NativeAction({ label, onPress, disabled = false, secondary = false, theme, testID }: {
  label: string; onPress: () => void; disabled?: boolean; secondary?: boolean; theme: Theme; testID?: string;
}) {
  return (
    <Host matchContents style={{ minHeight: 48 }} seedColor={theme.primaryFill} colorScheme={theme.scheme}>
      <Button
        testID={testID}
        variant={secondary ? 'outlined' : 'filled'}
        onPress={onPress}
        disabled={disabled}
        style={{ height: 48, paddingHorizontal: 20, borderRadius: 8,
          backgroundColor: secondary ? theme.surface : theme.primaryFill,
          opacity: disabled ? 0.45 : 1 }}
      >
        <Text textStyle={{ color: secondary ? theme.primary : theme.primaryInk, fontSize: 16, fontWeight: '600' }}>
          {label}
        </Text>
      </Button>
    </Host>
  );
}

export function NativeAppearanceSwitch({ value, onValueChange, theme }: {
  value: boolean; onValueChange: (value: boolean) => void; theme: Theme;
}) {
  return <Host matchContents seedColor={theme.primaryFill} colorScheme={value ? 'dark' : 'light'}>
    <Switch label="Dark appearance" value={value} onValueChange={onValueChange} />
  </Host>;
}
