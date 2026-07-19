// AIcut GUI type definitions
export interface CanvasConfig { width: number; height: number; fps?: number; sample_rate?: number }
export interface AssetConfig { id: string; type: string; path: string; duration?: number; width?: number; height?: number; codec?: string }
export interface TransformConfig { x?: number; y?: number; scale_x?: number; scale_y?: number; rotation?: number; opacity?: number }
export interface RangeConfig { start: number; end: number }
export interface ClipConfig {
  id: string; assetId: string; src_range: RangeConfig; timelineIn: number; timelineOut: number;
  transform?: TransformConfig; volume?: number; speed?: number;
  effects?: any[]; masks?: any[]; filters?: any[]; keyframes?: Record<string, any>;
}
export interface TrackConfig { id: string; type: string; order?: number; clips: ClipConfig[] }
export interface ProjectConfig { version?: string; canvas: CanvasConfig; assets: AssetConfig[]; tracks: TrackConfig[] }
export interface MediaInfo { path: string; media_type: string; duration: number; width: number; height: number; codec: string; fps: number }
export interface RenderResult { command: string }

declare global { interface Window { aicut: AicutAPI } }
export interface AicutAPI {
  render(json: string): Promise<{ success: boolean; command?: string; error?: string }>;
  probe(path: string): Promise<{ success: boolean; info?: MediaInfo; error?: string }>;
  getPresets(): Promise<string[]>;
  getVersion(): Promise<string>;
  validate(json: string): Promise<{ valid: boolean; errors?: string[] }>;
  openFiles(): Promise<string[]>;
  saveProject(path: string, content: string): Promise<boolean>;
  loadProject(path: string): Promise<string>;
}
