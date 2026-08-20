export interface UpdateOffer {
  version?: string;
  canInstall?: boolean;
}

export interface UpdateBridge {
  pending(): Promise<UpdateOffer | null>;
  install(): Promise<void>;
  openRelease(): Promise<void>;
  openWidget(): Promise<void>;
  onOffer(handler: (offer: UpdateOffer | null) => void): Promise<unknown>;
}

export const RELEASES_URL: string;
export function tauriBridge(win: unknown): UpdateBridge | null;
export function updateNoticeHtml(
  offer: UpdateOffer | null | undefined,
  phase?: "idle" | "installing" | "failed",
  error?: string,
): string;
export function mountUpdateNotice(node: unknown, bridge: UpdateBridge | null): void;
