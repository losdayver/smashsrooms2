import {
  IBehaviouredPropExt,
  IExternalEvent,
  UpdateBehavioursExt,
} from "../../../types/sceneTypes";
import { Client } from "../client/client.js";
import { imgRoutes } from "../routes.js";

export class EaselManager {
  private pivot: HTMLDivElement;
  private propList: IEaselProp[] = [];
  client: Client;

  private loadProp = (prop: IBehaviouredPropExt) => {
    const img = document.createElement("img");
    img.id = prop.ID;
    img.src = `${imgRoutes}${prop.drawable.animationCode}.png`;
    img.style.top = prop.positioned.posY as unknown as string;
    img.style.left = prop.positioned.posX as unknown as string;
    img.className = "prop-sprite";
    this.pivot.appendChild(img);
    const easelProp = {
      ...prop,
      container: img,
    } satisfies IEaselProp;
    this.propList.push(easelProp);
  };

  private updateProps = (update: UpdateBehavioursExt) => {
    Object.entries(update)?.forEach(([propID, changes]) => {
      const el = document.getElementById(propID);
      if (!el) return;
      if (changes.positioned) {
        el.style.top = (changes.positioned as any).posY;
        el.style.left = (changes.positioned as any).posX;
      }
    });
  };

  private onConnectHandler = (status: boolean) => {};
  private onSceneEventHandler = (data: IExternalEvent) => {
    data.load?.forEach((prop) => {
      if (prop.drawable) this.loadProp(prop);
    });
    if (data.update) this.updateProps(data.update);
  };

  constructor(
    easelDiv: HTMLDivElement | HTMLSpanElement,
    client: Client,
    onAfterConnect?: (status: boolean) => void
  ) {
    this.pivot = document.createElement("div");
    easelDiv.appendChild(this.pivot);
    this.pivot.style.position = "relative";
    this.client = client;

    client.init((status) => {
      this.onConnectHandler(status);
      onAfterConnect?.(status);
    }, this.onSceneEventHandler);
  }
}

interface IEaselProp extends IBehaviouredPropExt {
  container: HTMLElement;
}