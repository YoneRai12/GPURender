export type SpeakerId = "zundamon" | "metan";

export type TalkVideoProject = {
  $schema?: string;
  schemaVersion: "1.0.0";
  project: {
    id: string;
    title: string;
    language: string;
    description: string;
    sourceDocuments?: Array<{
      label: string;
      path: string;
    }>;
  };
  timeline: {
    fps: number;
    width: number;
    height: number;
    durationFrames: number;
    startTimecode?: string;
    randomSeed?: number;
    colorProfile?: string;
    audioMix: {
      combinedNarrationPath: string;
      finalMixPath: string;
      bgmPath?: string;
    };
  };
  characters: Array<{
    id: SpeakerId;
    displayName: string;
    voice: {
      speakerName: string;
      styleName: string;
      speedScale: number;
    };
    visual: {
      accent: string;
      accentSoft?: string;
      avatarPath: string;
      blinkUpperPath: string;
      defaultExpression?: string;
      upperDir: string;
    };
  }>;
  style: {
    layout: string;
    subtitleBand: {
      alwaysVisible: boolean;
      showSpeakerName: boolean;
      speakerColors?: Partial<Record<SpeakerId, string>>;
      maxLines?: number;
      lineBreakRule?: string;
    };
    cardLayout?: {
      mainCardWidth?: number;
      mainCardHeight?: number;
      innerPanelStyle?: string;
    };
    characterLayout?: {
      zundamonFacing?: string;
      zundamonPinned?: string;
      metanPinned?: string;
      activeScale?: number;
    };
  };
  sources: {
    projectRoot: string;
    scriptJsonPath: string;
    conversationManifestPath: string;
    remotionSceneSourcePath: string;
    cueDataPath: string;
    mouthDataPath: string;
    publicConversationDir: string;
  };
  renderTargets: {
    remotion: {
      compositionId: string;
      projectDir: string;
      outputPath?: string;
    };
    resolve: {
      exportDir: string;
      outputPath?: string;
      timelineFormatPreference: Array<"otio" | "fcpxml">;
    };
    gpu: {
      rendererProjectDir: string;
      outputPath?: string;
      sceneTemplate: string;
    };
  };
  sceneOverrides?: Array<{
    cueIndex: number;
    template: string;
    title?: string;
    description?: string;
  }>;
  lineOverrides?: Array<{
    cueIndex: number;
    text?: string;
    speedScale?: number;
  }>;
};

export type ValidationIssue = {
  severity: "error" | "warning";
  message: string;
  path?: string;
};

export type ValidationResult = {
  ok: boolean;
  projectPath: string;
  schemaPath: string;
  project?: TalkVideoProject;
  issues: ValidationIssue[];
};

export type RenderPlan = {
  mode: "dry-run";
  generatedAt: string;
  projectPath: string;
  schemaPath: string;
  outputPath: string;
  title: string;
  composition: {
    width: number;
    height: number;
    fps: number;
    durationFrames: number;
    estimatedSeconds: number;
  };
  renderer: {
    target: "gpu";
    template: string;
    colorProfile?: string;
    randomSeed?: number;
    sourceFps?: number;
  };
  assets: {
    characterCount: number;
    narrationPath: string;
    finalMixPath: string;
    bgmPath?: string;
  };
};
