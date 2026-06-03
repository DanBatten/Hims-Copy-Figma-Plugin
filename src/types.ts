export type AdCopy = {
  id: string;
  title: string;
  brand: string;
  category?: string;
  pageName?: string;
  batchName?: string;
  month?: string;
  projectId?: string;
  round?: string;
  format: "4x5" | "9x16" | "unknown";
  templateName: string;
  themeName?: string;
  themeBrief?: string;
  leadAngle?: string;
  visualDirection?: string;
  fields: Record<string, string>;
  disclaimers?: AdDisclaimer[];
};

export type AdDisclaimer = {
  type?: string;
  placement?: string;
  text: string;
};

export type HermesJob = {
  jobId: string;
  targetFileKey?: string;
  campaign?: {
    name?: string;
    brands?: string[];
    category?: string;
    page?: string;
    batch?: string;
    month?: string;
    projectId?: string;
    round?: string;
  };
  ads: AdCopy[];
  options?: {
    useTemplates?: boolean;
    includePrimaryText?: boolean;
  };
};

export type GenerateMessage = {
  type: "generate";
  ads: AdCopy[];
  jobId?: string;
  options: {
    useTemplates: boolean;
    includePrimaryText: boolean;
  };
};

export type PatchTextFieldJob = {
  jobId: string;
  mode: "patchTextField";
  sourceCommentId?: string;
  fileKey?: string;
  target: {
    adId: string;
    field: string;
  };
  value: string;
};

export type PatchTextFieldMessage = {
  type: "patchTextField";
  job: PatchTextFieldJob;
};

export type RelayoutFallbackAdsJob = {
  jobId: string;
  mode: "relayoutFallbackAds";
};

export type RelayoutFallbackAdsMessage = {
  type: "relayoutFallbackAds";
  job: RelayoutFallbackAdsJob;
};

export type PluginMessage = GenerateMessage | PatchTextFieldMessage | RelayoutFallbackAdsMessage;
