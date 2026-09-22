/**
 * 换肤演示数据（不是样式来源）。
 *
 * 这里出现色值是有意的：它模拟「服务端换肤护栏算完之后下发的色阶」，
 * 属于接口返回数据，不是组件样式。判断标准很简单 ——
 * 如果把它删掉，组件仍然正常显示；如果把它写进组件，换肤就会失效。
 */
export interface ThemeSample {
  code: string;
  name: string;
  note: string;
  scale: Record<string, string>;
}

export const THEME_SAMPLES: ThemeSample[] = [
  {
    code: 't000001',
    name: '张姐零食铺',
    note: '默认暖橙 —— 与 Token 基线一致',
    scale: {
      50: '#FFF6F0',
      100: '#FFE8D9',
      200: '#FFCFB0',
      300: '#FFAE7E',
      400: '#FF8B4D',
      500: '#F26B21',
      600: '#D8551A',
      700: '#B8440F',
      800: '#8F3208',
      '--brand-ring': 'rgba(242,107,33,.13)',
    },
  },
  {
    code: 't000002',
    name: '青柠便利',
    note: '换成绿色主色 —— 注意「已送达」的绿与语义绿完全无关，语义色一个像素都没变',
    scale: {
      50: '#F0FDF4',
      100: '#DCFCE7',
      200: '#BBF7D0',
      300: '#86EFAC',
      400: '#4ADE80',
      500: '#16A34A',
      600: '#15803D',
      700: '#166534',
      800: '#14532D',
      '--brand-ring': 'rgba(22,163,74,.14)',
    },
  },
  {
    code: 't000003',
    name: '蓝鲸小店',
    note: '换成蓝色主色 —— 注意「配送中」的蓝与主色蓝同屏时仍然可区分（语义蓝更暗更沉）',
    scale: {
      50: '#EFF6FF',
      100: '#DBEAFE',
      200: '#BFDBFE',
      300: '#93C5FD',
      400: '#60A5FA',
      500: '#2563EB',
      600: '#1D4ED8',
      700: '#1E40AF',
      800: '#1E3A8A',
      '--brand-ring': 'rgba(37,99,235,.14)',
    },
  },
  {
    code: 't000004',
    name: '紫罗兰',
    note: '换成紫色主色 —— 四种主题下，Tag 的语义色值必须逐字节一致（AC-04）',
    scale: {
      50: '#F5F3FF',
      100: '#EDE9FE',
      200: '#DDD6FE',
      300: '#C4B5FD',
      400: '#A78BFA',
      500: '#7C3AED',
      600: '#6D28D9',
      700: '#5B21B6',
      800: '#4C1D95',
      '--brand-ring': 'rgba(124,58,237,.14)',
    },
  },
];
