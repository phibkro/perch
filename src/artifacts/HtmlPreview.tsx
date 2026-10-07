import React, { useMemo } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import { ARTIFACT_ORIGIN, buildIsolatedHtmlPreview, permitsPreviewNavigation } from './html';

export interface HtmlPreviewProps { content: string; interactive: boolean; dark: boolean; }

/** No onMessage handler: generated HTML has no React Native message bridge. */
export function HtmlPreview({ content, interactive, dark }: HtmlPreviewProps) {
  const html = useMemo(() => buildIsolatedHtmlPreview(content, interactive, dark), [content, interactive, dark]);
  return <View style={{ flex: 1, minHeight: 280, backgroundColor: dark ? '#18221D' : '#FFFFFF' }}>
    <WebView key={String(interactive)} testID="artifact-html" source={{ html, baseUrl: ARTIFACT_ORIGIN }}
      style={{ flex: 1, backgroundColor: 'transparent' }} originWhitelist={['*']}
      onShouldStartLoadWithRequest={request => permitsPreviewNavigation(request.url) || request.url === 'about:srcdoc' || request.url.startsWith('about:srcdoc#')}
      javaScriptEnabled={interactive} javaScriptCanOpenWindowsAutomatically={false}
      domStorageEnabled={false} cacheEnabled={false} incognito
      allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
      sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false} mixedContentMode="never"
      allowsInlineMediaPlayback={false} mediaPlaybackRequiresUserAction
      setSupportMultipleWindows onOpenWindow={() => {}} />
  </View>;
}
