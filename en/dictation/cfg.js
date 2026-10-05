/* 英语听写 · 语言层覆盖
   听写内核就是日语页那一份（dictation/dictation.js），本页只注入这个覆盖对象：
   发音语言、语音兜底规则、判题、词形归一化、文案，以及三套独立存储 key。
   ⚠️ 本文件必须在 dictation.js 之前加载（内核在文件顶部读一次）。 */
window.DICTATION_CFG = {
  /* 英语只用浏览器自带发音：内核先按 lang === 'en-US' 精确找，再走下面的前缀兜底。
     本页设置里只有「浏览器内置」一个引擎选项，所以 VOICEVOX / Azure 两条路走不到。 */
  speechLang: 'en-US',
  voiceMatch: function (lang) { return /^en/i.test(lang || ''); },

  /* 归一化：去首尾空白、大小写不敏感、内部空白折叠成一个空格。
     词形还原那种事不做 —— 听写要的就是原形拼写。 */
  norm: function (s) {
    return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
  },

  /* 判题：只比单词本身（不看音标），大小写与首尾空白不敏感。
     以 CFG 为 this 调用，所以这里能用 this.norm。 */
  isAnswer: function (input, item) {
    var v = this.norm(input);
    return !!v && v === this.norm(item && item.w);
  },

  /* 三套存储 key 与日语侧完全分开：日语听写进度不受影响，反之亦然。 */
  settingsKey: 'en-dictation-settings',
  progressKey: 'en-dictation-progress',
  wrongbookKey: 'en-dictation-wrongbook',

  /* 文案：内核的内置文案本来就是中文界面，只有这几条是日语专用的。 */
  texts: {
    pageTitle: '英语单词听写',
    testPhrase: 'Hello. This is a test of the English speech engine.',
    inputLabel: '听音拼写单词',
    inputPlaceholder: '输入听到的单词',
    playCurrent: '播放当前单词',
    meaningLabel: '中文释义'
  }
};
