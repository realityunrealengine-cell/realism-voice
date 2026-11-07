// Типы файлов, которые могут выполнить код при открытии. Такие вложения никогда не открываются
// автоматически; перед открытием показывается предупреждение. Общий код main-процесса и интерфейса.

const DANGEROUS_EXT = new Set([
  'exe', 'msi', 'msix', 'msixbundle', 'appx', 'appxbundle', 'msp', 'mst', 'com', 'scr', 'pif', 'cpl', 'dll', 'sys', 'drv', 'ocx',
  'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'ps1xml', 'psc1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'wsc', 'ws', 'hta', 'jar',
  'lnk', 'url', 'scf', 'inf', 'reg', 'gadget', 'application', 'appref-ms', 'vb', 'vbscript', 'sct', 'chm', 'hlp', 'iso',
  'img', 'vhd', 'vhdx', 'library-ms', 'settingcontent-ms', 'xll', 'xlam', 'docm', 'dotm', 'xlsm', 'xltm', 'pptm', 'potm',
  'ppam', 'ppsm', 'sldm', 'appinstaller', 'diagcab', 'mshxml', 'website', 'theme', 'themepack', 'search-ms', 'msc',
]);

export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase().replace(/[. ]+$/, '') : '';
}

export function isDangerousFile(name: string): boolean {
  return DANGEROUS_EXT.has(fileExtension(name));
}
