import React, { useMemo, useState } from 'react';
import { FlatList, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Check, Search } from 'lucide-react-native';
import type { ModelMetadata } from '../session';
import type { Theme } from './theme';

/** Catalog data and credentials belong to the host; the phone only filters metadata. */
export function ModelPicker({ models, selected, disabled, theme: t, onSelect }: {
  models: readonly ModelMetadata[]; selected?: ModelMetadata; disabled: boolean;
  theme: Theme; onSelect: (model: ModelMetadata) => void;
}) {
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<string | null>(null);
  const providers = useMemo(() => [...new Set(models.map(model => model.provider).filter((id): id is string => !!id))].sort(), [models]);
  const filtered = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return models.filter(model => (!provider || model.provider === provider) && words.every(word =>
      `${model.name || ''} ${model.id} ${model.provider || ''}`.toLocaleLowerCase().includes(word)))
      .sort((a, b) => (a.provider || '').localeCompare(b.provider || '') || (a.name || a.id).localeCompare(b.name || b.id));
  }, [models, provider, query]);
  return <View style={{ flex: 1, minHeight: 0, gap: 12 }}>
    <Text style={{ color: t.muted, fontSize: 13, lineHeight: 20 }}>Choose from models available on your host. The next message uses your selection.</Text>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: t.controlLine, borderRadius: 8, paddingHorizontal: 13, backgroundColor: t.background }}>
      <Search size={18} color={t.muted} />
      <TextInput accessibilityLabel="Search models and providers" placeholder="Search models or providers…" placeholderTextColor={t.subtle} value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} style={{ flex: 1, minHeight: 48, color: t.ink, fontSize: 15 }} />
    </View>
    <View><ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 7 }}>
      {[null, ...providers].map(id => <Pressable key={JSON.stringify(id)} accessibilityRole="button" accessibilityLabel={id ? `Filter provider ${id}` : 'All providers'} aria-selected={provider === id} accessibilityState={{ selected: provider === id }} onPress={() => setProvider(id)} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 13, borderRadius: 8, borderWidth: 1, borderColor: provider === id ? t.primary : t.line, backgroundColor: provider === id ? t.primarySoft : t.surface }}>
        <Text style={{ color: provider === id ? t.primary : t.muted, fontSize: 12 }}>{id || 'All providers'}</Text>
      </Pressable>)}
    </ScrollView></View>
    <Text accessibilityLiveRegion="polite" style={{ color: t.muted, fontSize: 11 }}>{filtered.length} of {models.length} models · {providers.length} providers</Text>
    {disabled && <Text style={{ color: t.amber, fontSize: 12, lineHeight: 18 }}>Model changes are available when this session is connected and idle.</Text>}
    <FlatList data={filtered} keyboardShouldPersistTaps="handled" style={{ flex: 1 }} initialNumToRender={12} maxToRenderPerBatch={12} windowSize={5}
      keyExtractor={model => JSON.stringify([model.provider, model.id])}
      ListEmptyComponent={<Text style={{ color: t.muted, fontSize: 14, lineHeight: 22, paddingVertical: 22 }}>No matching models. Try another search or provider.</Text>}
      renderItem={({ item: model }) => {
        const isSelected = selected?.id === model.id && selected?.provider === model.provider;
        return <Pressable accessibilityRole="radio" accessibilityLabel={`${model.name || model.id} · ${model.provider || 'Host provider'}`} aria-checked={isSelected} accessibilityState={{ checked: isSelected, disabled: disabled || !model.provider }} disabled={disabled || !model.provider} onPress={() => onSelect(model)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 15, marginBottom: 8, borderRadius: 12, minHeight: 68, borderWidth: 1, borderColor: isSelected ? t.primary : t.line, backgroundColor: isSelected ? t.primarySoft : t.surface, opacity: disabled ? .6 : 1 }}>
          <View style={{ flex: 1 }}><Text numberOfLines={2} style={{ color: t.ink, fontSize: 14, fontWeight: '600', lineHeight: 21 }}>{model.name || model.id}</Text><Text numberOfLines={2} style={{ color: t.muted, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11, lineHeight: 18, marginTop: 3 }}>{model.provider || 'Host provider'} · {model.id}</Text></View>
          {isSelected && <Check size={18} color={t.primary} />}
        </Pressable>;
      }} />
  </View>;
}
