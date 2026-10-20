declare module "@met4citizen/talkinghead" {
  import type { Camera, Group, Scene } from "three";
  export class TalkingHead {
    constructor(node: HTMLElement, options: Record<string, unknown>);
    armature: Group;
    scene: Scene;
    camera: Camera;
    audioReverbNode?: AudioNode;
    mtAvatar: Record<
      string,
      { value: number; realtime?: number | null; needsUpdate?: boolean }
    >;
    showAvatar(options: Record<string, unknown>): Promise<void>;
    animate(deltaMilliseconds: number): void;
    start(): void;
    stop(): void;
    setMood(mood: string): void;
    lookAtCamera(milliseconds: number): void;
    lookAt(x: number, y: number, milliseconds: number): void;
    setFixedValue(name: string, value: number | null): void;
    dispose(): void;
  }
}
