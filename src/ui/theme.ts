/**
 * Tern's documented kit defaults, adapted to native semantic roles.
 * Keep the assistant-ui equivalents in global.css aligned with these values.
 * See docs/TERN-OMP-VISUAL-DESIGN.md for provenance and adaptations.
 * `primary` is readable ink; `primaryFill` carries white button text.
 */
export const lightTheme = {
  scheme: 'light' as 'light' | 'dark',
  background: '#FBFBFA', chrome: '#EFEFEC', surface: '#FFFFFF', surfaceAlt: '#F4F4F2',
  ink: '#1B1C20', muted: '#55575F', subtle: '#6A6C74', line: 'rgba(27,28,32,0.10)',
  controlLine: '#8B8D95',
  primary: '#2448C4', primarySoft: '#EAF0FF', primaryFill: '#2F63F0', primaryInk: '#FFFFFF',
  success: '#167A4D', successSoft: '#EDF8F2', activity: '#7540BD', activitySoft: '#F4EDFC',
  lime: '#EAF0FF', limeInk: '#2448C4', amber: '#8A6000', amberSoft: '#FFF5DF',
  error: '#BF3038', errorSoft: '#FFF0F0', dark: '#161619', onDark: '#EDEDED',
  backdrop: 'rgba(27,28,32,0.32)', code: '#0C0C0D', codeInk: '#E4E4E7',
};

export const darkTheme: typeof lightTheme = {
  scheme: 'dark',
  background: '#0F0F12', chrome: '#08080A', surface: '#161619', surfaceAlt: '#1D1D21',
  ink: '#EDEDED', muted: '#A1A1A1', subtle: '#8A8A92', line: 'rgba(255,255,255,0.10)',
  controlLine: '#62636C',
  primary: '#9DBCFF', primarySoft: '#1B2743', primaryFill: '#2A5FE0', primaryInk: '#FFFFFF',
  success: '#3ECF8E', successSoft: '#13271E', activity: '#A86AF4', activitySoft: '#241B32',
  lime: '#1B2743', limeInk: '#9DBCFF', amber: '#F5A524', amberSoft: '#302512',
  error: '#FF6166', errorSoft: '#301A1D', dark: '#08080A', onDark: '#EDEDED',
  backdrop: 'rgba(0,0,0,0.65)', code: '#0C0C0D', codeInk: '#E4E4E7',
};

export type Theme = typeof lightTheme;
