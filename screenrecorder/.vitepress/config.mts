import { defineConfig } from 'vitepress'

/**
 * 小白录制 官网。
 *
 * 站点挂在博客（仓库根，Astro）的子路径下，所以 base 必须是 /screenrecorder/，
 * 构建产物由根目录的 .github/workflows/deploy.yml 同步到 public/screenrecorder/。
 * 注意：head 里的图标/og:image 用的是绝对路径，改 base 时要一并改；
 * themeConfig.logo 交给 VitePress 自动加 base，不用手写。
 */
export default defineConfig({
  lang: 'zh-CN',
  title: '小白录制',
  description:
    '本机运行的高帧率屏幕录制与视频处理工具：系统录屏 / Shizuku / Root 三种采集方式，无账号、无云端、不上传。',
  base: '/screenrecorder/',
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/screenrecorder/icon.png' }],
    ['meta', { name: 'theme-color', content: '#277af7' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: '小白录制 · 高帧率屏幕录制与视频处理' }],
    [
      'meta',
      {
        property: 'og:description',
        content: '系统录屏 / Shizuku / Root 三种采集方式，系统声音与麦克风混音，区域录制、悬浮球、屏幕标注与视频工具箱。',
      },
    ],
    ['meta', { property: 'og:image', content: '/screenrecorder/icon.png' }],
  ],
  themeConfig: {
    logo: '/icon.png',
    nav: [
      { text: '首页', link: '/' },
      { text: '使用指南', link: '/guide/' },
      { text: '录制', link: '/record/modes' },
      { text: '视频工具', link: '/tools/' },
      { text: '相册', link: '/album/' },
      { text: '设置', link: '/settings/' },
      { text: '高级版', link: '/premium/' },
      {
        text: '更多',
        items: [
          { text: '版本对比', link: '/versions' },
          { text: '常见问题', link: '/faq' },
          { text: '隐私政策', link: '/privacy' },
          { text: '用户协议', link: '/terms' },
          { text: '更新日志', link: '/changelog' },
        ],
      },
      { text: '博客', link: 'https://sunight06.github.io/' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: '开始使用',
          items: [
            { text: '功能总览', link: '/guide/' },
            { text: '安装与首次启动', link: '/guide/install' },
            { text: '界面导览', link: '/guide/interface' },
            { text: '权限说明', link: '/guide/permissions' },
          ],
        },
        {
          text: '录制',
          items: [
            { text: '三种录制方式', link: '/record/modes' },
            { text: '录制参数', link: '/record/parameters' },
            { text: '参数与设备支持', link: '/record/capabilities' },
            { text: '声音与混音', link: '/record/audio' },
            { text: '区域录制', link: '/record/region' },
            { text: '悬浮球与工具栏', link: '/record/floating' },
            { text: '屏幕标注', link: '/record/annotation' },
            { text: '触摸可视化', link: '/record/touch' },
            { text: '摄像头小窗与启动音效', link: '/record/extras' },
            { text: '保存、暂停与恢复', link: '/record/output' },
          ],
        },
        {
          text: '录制之后',
          items: [
            { text: '视频工具箱', link: '/tools/' },
            { text: '相册', link: '/album/' },
            { text: '设置与外观', link: '/settings/' },
            { text: '高级版权益', link: '/premium/' },
          ],
        },
      ],
      '/record/': [
        {
          text: '录制',
          items: [
            { text: '三种录制方式', link: '/record/modes' },
            { text: '录制参数', link: '/record/parameters' },
            { text: '参数与设备支持', link: '/record/capabilities' },
            { text: '声音与混音', link: '/record/audio' },
            { text: '区域录制', link: '/record/region' },
            { text: '悬浮球与工具栏', link: '/record/floating' },
            { text: '屏幕标注', link: '/record/annotation' },
            { text: '触摸可视化', link: '/record/touch' },
            { text: '摄像头小窗与启动音效', link: '/record/extras' },
            { text: '保存、暂停与恢复', link: '/record/output' },
          ],
        },
      ],
      '/tools/': [
        {
          text: '视频工具箱',
          items: [
            { text: '总览', link: '/tools/' },
            { text: '运行库', link: '/tools/runtime' },
            { text: '格式转换', link: '/tools/convert' },
            { text: '提取音频', link: '/tools/extract' },
            { text: '视频压缩', link: '/tools/compress' },
            { text: '视频超分', link: '/tools/upscale' },
            { text: '旋转与镜像', link: '/tools/rotate' },
            { text: '视频倒放', link: '/tools/reverse' },
            { text: '音量调整', link: '/tools/volume' },
            { text: '抖音投稿帧数优化', link: '/tools/douyin' },
          ],
        },
      ],
      '/album/': [
        {
          text: '相册',
          items: [
            { text: '总览', link: '/album/' },
            { text: '排序、布局与显示字段', link: '/album/view' },
            { text: '播放、分享与信息', link: '/album/actions' },
            { text: '重命名与删除', link: '/album/manage' },
            { text: '保存位置与媒体库', link: '/album/storage' },
          ],
        },
      ],
      '/settings/': [
        {
          text: '设置与外观',
          items: [
            { text: '设置总览', link: '/settings/' },
            { text: '主题与外观', link: '/settings/theme' },
            { text: '控制与安全', link: '/settings/control' },
            { text: '外部启动', link: '/settings/external' },
            { text: '数据与隐私', link: '/settings/privacy' },
          ],
        },
      ],
      '/premium/': [
        {
          text: '高级版',
          items: [
            { text: '权益总览', link: '/premium/' },
            { text: '解锁与激活', link: '/premium/unlock' },
            { text: '试用与限制', link: '/premium/trial' },
            { text: '实测数据', link: '/premium/benchmark' },
          ],
        },
      ],
    },
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            displayDetails: '显示详细列表',
            resetButtonTitle: '清除查询条件',
            backButtonTitle: '返回',
            noResultsText: '没有找到相关结果',
            footer: {
              selectText: '选择',
              selectKeyAriaLabel: '回车',
              navigateText: '切换',
              navigateUpKeyAriaLabel: '上箭头',
              navigateDownKeyAriaLabel: '下箭头',
              closeText: '关闭',
              closeKeyAriaLabel: 'Esc',
            },
          },
        },
      },
    },
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '外观',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
    footer: {
      message: '全部处理都在你的设备上完成 · 无账号 · 无云端 · 不上传',
      copyright: '© 2026 左一铭 · 鲁ICP备2024133585号-2A',
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/Sunight06' }],
  },
})
