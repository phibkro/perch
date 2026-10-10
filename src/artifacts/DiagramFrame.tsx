import React from 'react';
import { WebView } from 'react-native-webview';
import { ARTIFACT_ORIGIN, permitsPreviewNavigation } from './html';

export interface DiagramFrameProps { html: string; }

/** The frame runs the bundled renderer, with no React Native message bridge. */
export function DiagramFrame({ html }: DiagramFrameProps) {
  return <WebView testID="artifact-diagram" source={{ html, baseUrl: ARTIFACT_ORIGIN }}
    style={{ flex: 1, backgroundColor: 'transparent' }} originWhitelist={['*']}
    onShouldStartLoadWithRequest={request => permitsPreviewNavigation(request.url) || request.url === 'about:srcdoc' || request.url.startsWith('about:srcdoc#')}
    javaScriptEnabled javaScriptCanOpenWindowsAutomatically={false}
    domStorageEnabled={false} cacheEnabled={false} incognito
    allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
    sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false} mixedContentMode="never"
    allowsInlineMediaPlayback={false} mediaPlaybackRequiresUserAction
    setSupportMultipleWindows onOpenWindow={() => {}} />;
}
