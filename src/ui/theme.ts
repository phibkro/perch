export const lightTheme = {
  background: '#F5F5F0', surface: '#FFFFFF', surfaceAlt: '#ECEEE7',
  ink: '#25332D', muted: '#67746C', subtle: '#889188', line: '#E0E5DC',
  primary: '#345E49', primarySoft: '#E6EEDF', primaryInk: '#FFFFFF',
  lime: '#DAEBAA', limeInk: '#2D4228', amber: '#8E5D24', amberSoft: '#F8EDD7',
  error: '#A33F3B', errorSoft: '#FCE9E5', dark: '#263F33', onDark: '#FAFFF3',
  backdrop: 'rgba(22,35,27,0.40)', code: '#26342D', codeInk: '#DAE9CE',
};

export const darkTheme: typeof lightTheme = {
  background: '#17221D', surface: '#202E26', surfaceAlt: '#2A3930',
  ink: '#E5EDDF', muted: '#A6B4A6', subtle: '#85978A', line: '#36493B',
  primary: '#C2DBA4', primarySoft: '#324C34', primaryInk: '#21371F',
  lime: '#DAEBAA', limeInk: '#2D4228', amber: '#EDC988', amberSoft: '#453B27',
  error: '#FFB4A8', errorSoft: '#4B302E', dark: '#2A4637', onDark: '#FAFFF3',
  backdrop: 'rgba(0,0,0,0.65)', code: '#131E17', codeInk: '#D6E6CC',
};

export type Theme = typeof lightTheme;
