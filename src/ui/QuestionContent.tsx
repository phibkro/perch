import React, { useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ArrowLeft, BookOpen, ChevronRight } from 'lucide-react-native';
import type { PendingQuestion, SessionSnapshot } from '../session';
import { MarkdownPreview } from '../artifacts/MarkdownPreview';
import { NativeAction } from './NativeAction';
import type { Theme } from './theme';

/** A receipt describes delivery, not whether the host accepted the decision. */
export function questionProgress(question: PendingQuestion): string | undefined {
  if (question.answerState === 'unknown') return 'Answer outcome is unconfirmed';
  if (question.answerState === 'sending') return 'Sending your answer…';
  if (question.answerState === 'forwarded') return 'Answer forwarded · waiting for host';
  if (question.answering) return 'Waiting for host…';
  return undefined;
}

/** Mount with the scoped request ID and kind so a replacement cannot inherit an answer. */
export function QuestionContent({ question, state, theme: t, answer, onAnswerChange, onSubmit }: {
  question: PendingQuestion; state: SessionSnapshot; theme: Theme; answer: string; onAnswerChange: (answer: string) => void; onSubmit: (answer: string) => void;
}) {
  const s = useMemo(() => styles(t), [t]);
  const [reading, setReading] = useState(question.category === 'plan' && !!question.document);
  const [source, setSource] = useState(false);
  const connected = state.connection.status === 'demo' || state.connection.status === 'live';
  const sending = !!question.answering || !!question.answerState;
  const blockedReason = state.readOnly ? 'This session is view only. Answer on the host or join with a write-enabled link.'
    : !connected ? 'Reconnect before sending an answer.'
    : state.sessionAction ? 'Wait for the session change before answering.'
    : question.disabledReason || (!state.capabilities.questions ? 'This host cannot accept this answer from Perch. Answer on the host.' : undefined);
  const disabled = !!blockedReason || sending;
  const selectedOption = question.options?.find(option => option.id === answer);
  const valid = question.kind === 'editor' ? !!answer.trim() : !!selectedOption && !selectedOption.disabled;
  const status = questionProgress(question);
  const category = question.category === 'approval' ? 'APPROVAL REQUEST' : question.category === 'plan' ? 'PLAN REVIEW' : 'YOUR ASSISTANT NEEDS A DECISION';

  if (reading && question.document) return <View testID="question-document" style={s.flex}>
    <View style={s.documentHeader}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back to request" onPress={() => setReading(false)} style={s.action}><ArrowLeft size={17} color={t.primary} /><Text style={s.actionText}>Request</Text></Pressable>
      <Text selectable numberOfLines={2} style={[s.documentTitle, s.flex]}>{question.document.title}</Text>
    </View>
    {question.disabledReason && <Text accessibilityRole="alert" style={[s.notice, { marginTop: 0, marginBottom: 10 }]}>{question.disabledReason}</Text>}
    {question.document.format === 'markdown' && <View accessibilityRole="tablist" style={s.tabs}>
      {['Preview', 'Source'].map((label, index) => <Pressable key={label} accessibilityRole="tab" accessibilityLabel={`Request document ${label.toLowerCase()}`} accessibilityState={{ selected: source === !!index }} aria-selected={source === !!index} onPress={() => setSource(!!index)} style={[s.tab, source === !!index && { borderColor: t.primary, backgroundColor: t.primarySoft }]}><Text style={[s.actionText, { color: source === !!index ? t.primary : t.muted }]}>{label}</Text></Pressable>)}
    </View>}
    <View style={s.reader}>
      {!source && question.document.format === 'markdown'
        ? <MarkdownPreview content={question.document.content} theme={t} />
        : <ScrollView testID="question-document-source" style={s.flex} contentContainerStyle={s.sourceContent} keyboardShouldPersistTaps="handled"><Text selectable accessibilityLabel="Document source" style={s.source}>{question.document.content}</Text></ScrollView>}
    </View>
    <View style={s.readerFooter}><NativeAction label="Review choices" theme={t} secondary onPress={() => setReading(false)} /></View>
  </View>;

  return <ScrollView testID="question-response" style={s.flex} contentContainerStyle={{ paddingBottom: 4 }} keyboardShouldPersistTaps="handled">
    <Text style={s.eyebrow}>{category}</Text>
    {state.remote?.attached && <Text style={s.origin}>{state.remote.attached.location?.host ?? state.remote.host?.name ?? 'Host'} · {state.remote.attached.title}</Text>}
    <Text selectable style={s.prompt}>{question.prompt}</Text>
    {question.document && <Pressable testID="read-request-document" accessibilityRole="button" accessibilityLabel={question.category === 'plan' ? 'Read plan' : 'Read request details'} onPress={() => setReading(true)} style={s.documentCard}>
      <BookOpen size={22} color={t.primary} /><View style={s.flex}><Text style={s.documentTitle}>{question.document.title}</Text><Text style={s.small}>{question.category === 'plan' ? 'Read the plan and its source.' : 'Read the request details.'}</Text></View><ChevronRight size={18} color={t.primary} />
    </Pressable>}
    {question.kind === 'editor'
      ? <TextInput accessibilityLabel="Answer to agent" accessibilityState={{ disabled }} editable={!disabled} value={answer} onChangeText={value => { if (!disabled) onAnswerChange(value); }} multiline style={[s.input, disabled && s.disabled]} placeholder="Write your answer…" placeholderTextColor={t.subtle} />
      : <View accessibilityRole="radiogroup" style={{ gap: 10 }}>{question.options?.map(option => {
        const optionDisabled = disabled || !!option.disabled;
        const selected = answer === option.id;
        return <Pressable key={option.id} accessibilityRole="radio" aria-checked={selected} accessibilityState={{ checked: selected, disabled: optionDisabled }} accessibilityLabel={option.label} disabled={optionDisabled} onPress={() => { if (!optionDisabled) onAnswerChange(option.id); }} style={[s.option, selected && { borderColor: t.primary, backgroundColor: t.primarySoft }, optionDisabled && s.disabled]}>
          <View style={[s.radio, selected && { borderColor: t.primary }]}>{selected && <View style={s.selectedDot} />}</View><View style={s.flex}><Text style={s.optionLabel}>{option.label}</Text>{option.description && <Text style={s.body}>{option.description}</Text>}{option.disabled && <Text style={s.small}>Unavailable on this host</Text>}</View>
        </Pressable>;
      })}</View>}
    {blockedReason && <Text accessibilityRole="alert" style={s.notice}>{blockedReason}</Text>}
    {!!status && <Text accessibilityLiveRegion="polite" style={s.notice}>{question.answerState === 'unknown'
      ? 'Answer outcome is unconfirmed. Check the host; Perch will not resend this answer automatically.'
      : question.answerState === 'forwarded' ? 'Answer forwarded. Waiting for the host to close this request.' : status}</Text>}
    <View style={s.submit}><NativeAction theme={t} label={question.answerState === 'unknown' ? 'Unconfirmed answer' : question.answerState === 'sending' ? 'Sending answer…' : sending ? 'Waiting for host…' : 'Send answer'} onPress={() => { if (!disabled && valid) onSubmit(answer); }} disabled={disabled || !valid} testID="send-answer" /></View>
    <Text style={[s.small, { textAlign: 'right', marginTop: 12 }]}>You can close this and return to the request later.</Text>
  </ScrollView>;
}

function styles(t: Theme) { return StyleSheet.create({
  flex: { flex: 1, minWidth: 0, minHeight: 0 },
  eyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 1.5, color: t.amber, marginBottom: 12 },
  origin: { fontSize: 11, lineHeight: 17, color: t.muted, marginBottom: 12 },
  body: { color: t.muted, fontSize: 13, lineHeight: 21 }, prompt: { color: t.ink, fontSize: 14, lineHeight: 22, marginBottom: 20 },
  small: { color: t.muted, fontSize: 11, lineHeight: 17 },
  documentTitle: { fontSize: 13, fontWeight: '600', lineHeight: 20, color: t.ink },
  documentCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: t.line, borderRadius: 14, padding: 16, marginBottom: 20, minHeight: 76 },
  input: { borderWidth: 1, borderColor: t.line, borderRadius: 12, backgroundColor: t.background, minHeight: 150, padding: 14, color: t.ink, fontSize: 15, lineHeight: 22, textAlignVertical: 'top' },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: t.line, padding: 16, borderRadius: 14, minHeight: 62 },
  optionLabel: { color: t.ink, fontSize: 13, fontWeight: '600', lineHeight: 20 },
  radio: { width: 20, height: 20, borderRadius: 12, borderWidth: 1.5, borderColor: t.subtle, alignItems: 'center', justifyContent: 'center' },
  selectedDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: t.primary },
  disabled: { opacity: .5 }, notice: { color: t.amber, fontSize: 13, lineHeight: 21, marginTop: 14 }, submit: { marginTop: 22, alignItems: 'flex-end' },
  documentHeader: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 8 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44 }, actionText: { fontSize: 12, fontWeight: '600', color: t.primary },
  tabs: { flexDirection: 'row', gap: 8, marginBottom: 10 }, tab: { minHeight: 44, minWidth: 86, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: t.line, borderRadius: 12 },
  reader: { flex: 1, minHeight: 0, borderWidth: 1, borderColor: t.line, borderRadius: 14, overflow: 'hidden' },
  readerFooter: { paddingTop: 12, alignItems: 'flex-end' },
  sourceContent: { padding: 18 }, source: { color: t.ink, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12, lineHeight: 20 },
}); }
