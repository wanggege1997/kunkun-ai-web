const ICP_BEIAN_URL = "https://beian.miit.gov.cn/";
const POLICE_BEIAN_BASE_URL = "https://www.beian.gov.cn/portal/registerSystemInfo";
const POLICE_ICON_URL = "https://www.beian.gov.cn/img/new/gongan.png";

function envValue(name: string) {
  return String(process.env[name] || "").trim();
}

function normalizeRecordCode(value: string) {
  return value.replace(/\D/g, "");
}

export function SiteFooter() {
  const ownerName = envValue("NEXT_PUBLIC_SITE_OWNER_NAME") || "坤坤 AI";
  const icpRecordNumber = envValue("NEXT_PUBLIC_ICP_RECORD_NUMBER");
  const policeRecordNumber = envValue("NEXT_PUBLIC_POLICE_RECORD_NUMBER");
  const policeRecordCode =
    normalizeRecordCode(envValue("NEXT_PUBLIC_POLICE_RECORD_CODE")) ||
    normalizeRecordCode(policeRecordNumber);

  const policeHref = policeRecordCode
    ? `${POLICE_BEIAN_BASE_URL}?recordcode=${policeRecordCode}`
    : POLICE_BEIAN_BASE_URL;

  return (
    <footer className="border-t border-zinc-200 bg-white px-4 py-5 text-center text-xs text-zinc-500">
      <p className="mb-2">© 2026 {ownerName} 版权所有</p>
      <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
        {icpRecordNumber ? (
          <a
            href={ICP_BEIAN_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-zinc-900"
          >
            {icpRecordNumber}
          </a>
        ) : (
          <span>ICP备案号待配置</span>
        )}

        <span className="text-zinc-300">|</span>

        {policeRecordNumber ? (
          <a
            href={policeHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:text-zinc-900"
          >
            {/* 公安备案要求展示官方图标；图标来源为全国互联网安全管理服务平台。 */}
            {/* eslint-disable-next-line @next/next/no-img-element -- 官方备案图标保持外链原样展示 */}
            <img src={POLICE_ICON_URL} alt="公安备案图标" className="h-4 w-4" />
            <span>{policeRecordNumber}</span>
          </a>
        ) : (
          <span className="inline-flex items-center gap-1">
            {/* eslint-disable-next-line @next/next/no-img-element -- 官方备案图标保持外链原样展示 */}
            <img src={POLICE_ICON_URL} alt="公安备案图标" className="h-4 w-4" />
            <span>公安备案号待配置</span>
          </span>
        )}
      </p>
    </footer>
  );
}
