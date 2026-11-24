/**
 * 左侧导航行图标（sidebar.panellist）：宿主负责整行点击/选中态与文字标签，
 * 这里只画图标（与 dshmarket 的 MarketLogo 同款契约：owner.size 为宿主给的尺寸）。
 */
export function TradingRow({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M2.6 12.4V9.2M6.1 12.4V5.4M9.6 12.4V7.6M13.1 12.4V3.6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M1.6 13.8h12.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.55" />
    </svg>
  )
}
