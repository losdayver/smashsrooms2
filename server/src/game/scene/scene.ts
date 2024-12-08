import {
  IClientActionEvent,
  IDestroyControlledPropEvent,
  IDestroyPropEvent,
  IExternalEvent,
  IInternalEvent,
  IScene,
  ISceneSubscriber,
  ISceneTemplate,
  ISpawnControlledPropEvent,
  ISpawnPropEvent,
} from "./sceneTypes";
import { doBenchmark, Mutex, severityLog } from "./../../utils";
import { Prop, propsMap } from "./props";
import { IControlled, IPositioned, IProp, PropBehaviours } from "./propTypes";
import { PropIDExt } from "../../../../types/sceneTypes";
import { StageExt } from "../../../../types/stage";

type ChunkedUpdateMap = Record<`${number}_${number}`, ChunkUpdate>;
type ChunkUpdate = {
  props: (IProp & PropBehaviours)[];
  /** prop ID followed by behaviour that was mutated */
  update: Record<PropIDExt, PropBehaviours>;
  load: (IProp & PropBehaviours)[];
  delete: string[];
};

export class Scene implements IScene {
  eventHandler: ISceneSubscriber["handlerForSceneExternalEvents"];

  private chunkSize = 256;
  private propList: (IProp & PropBehaviours)[] = []; // todo wrap it up in mutex
  private internalEventQueueMutex = new Mutex<IInternalEvent[]>([]);
  private internalEventHandlerMap: Record<
    IInternalEvent["name"],
    (data: any) => void
  >;
  private tickNum = 0;
  private stage: StageExt;

  private $chunkedUpdates: ChunkedUpdateMap = {};

  private $appendToChunkedUpdates = (
    partialChunk: Partial<ChunkUpdate>,
    prop: IPositioned
  ) => {
    const coordID = `${Math.floor(
      prop.positioned.posX / this.chunkSize
    )}_${Math.floor(prop.positioned.posY / this.chunkSize)}`;

    if (!this.$chunkedUpdates[coordID]) this.$chunkedUpdates[coordID] = {};
    const chunk = this.$chunkedUpdates[coordID];
    this.$chunkedUpdates[coordID] = {
      props: (chunk?.props ?? []).concat(partialChunk.props ?? []),
      update: { ...(chunk?.update ?? {}), ...(partialChunk.update ?? {}) },
      load: (chunk?.load ?? []).concat(partialChunk.load ?? []),
      delete: (chunk?.delete ?? []).concat(partialChunk.delete ?? []),
    } satisfies ChunkUpdate;
  };

  private $generateExternalEventBatch = (
    clientID: string | "all",
    type: "currentState" | "everyUpdate" | "localUpdates"
  ) => {
    let batch: IExternalEvent = {};
    if (type == "currentState") {
      Object.values(this.$chunkedUpdates).forEach((chunkedUpdate) => {
        if (chunkedUpdate.props) {
          if (!batch.load) batch.load = [];
          chunkedUpdate.props.forEach((prop) => {
            if (!prop.drawable) return;
            const partialProp: Omit<IProp, "scene"> & PropBehaviours = {
              ID: prop.ID,
              drawable: prop.drawable,
              positioned: prop.positioned,
            };
            if (prop.nameTagged) partialProp.nameTagged = prop.nameTagged;
            batch.load.push(partialProp);
          });
        }
      });
    } else if (type == "everyUpdate") {
      const tempUpdate = {};
      const tempLoad = [];
      let tempDelete = [];

      Object.values(this.$chunkedUpdates).forEach((chunkedUpdate) => {
        if (chunkedUpdate.update) {
          Object.entries(chunkedUpdate.update).forEach(([propID, update]) => {
            if ((update.positioned || update.drawable) && !tempUpdate[propID])
              tempUpdate[propID] = {};

            if (update.positioned)
              tempUpdate[propID].positioned = update.positioned;
            if (update.drawable) tempUpdate[propID].drawable = update.drawable;
          });
        }

        if (chunkedUpdate.load) {
          chunkedUpdate.load.forEach((prop) => {
            if (!prop.drawable) return;
            const tempProp = {
              ID: prop.ID,
              drawable: prop.drawable,
              positioned: prop.positioned,
            } as IProp & PropBehaviours;
            if (prop.nameTagged)
              tempProp.nameTagged = { tag: prop.nameTagged.tag };
            tempLoad.push(tempProp);
          });
        }

        if (chunkedUpdate.delete)
          tempDelete = tempDelete.concat(chunkedUpdate.delete);
      });

      if (Object.keys(tempUpdate).length) batch.update = tempUpdate;
      if (tempLoad.length) batch.load = tempLoad;
      if (tempDelete.length) batch.delete = tempDelete;
    }
    if (Object.keys(batch).length) this.eventHandler(batch, clientID);
  };

  $isProcessingTick = false;
  tick = async () => {
    const tickLoop = doBenchmark();
    if (this.$isProcessingTick) return;
    this.$isProcessingTick = true;
    // load all props $chunkedUpdates
    this.$chunkedUpdates = {};
    this.propList.forEach((prop) => {
      if (prop.positioned)
        this.$appendToChunkedUpdates({ props: [prop] }, prop as IPositioned);
    });

    this.propList.forEach((prop) => {
      if (prop.onTick) prop.onTick(this.tickNum);
    });

    // fire all internal even handlers
    if (this.internalEventQueueMutex.value.length) {
      const unlock = await this.internalEventQueueMutex.acquire();
      try {
        while (this.internalEventQueueMutex.value.length) {
          const event = this.internalEventQueueMutex.value.pop();
          this.internalEventHandlerMap[event.name]?.(event.data);
        }
      } finally {
        unlock();
      }
    }

    // collision detection
    const checkedCollisions: PropIDExt[] = [];
    for (const [coord, chunk] of Object.entries(this.$chunkedUpdates)) {
      const [x, y] = coord.split("_").map(Number);
      const adjecentChunks: ChunkUpdate[] = [chunk];

      for (const [coordAdj, chunkAdj] of Object.entries(this.$chunkedUpdates)) {
        const [xAdj, yAdj] = coordAdj.split("_").map(Number);

        if (
          chunkAdj != chunk &&
          Math.abs(xAdj - x) <= 1 &&
          Math.abs(yAdj - y) <= 1
        )
          adjecentChunks.push(chunkAdj);
      }

      for (const prop of chunk.props) {
        if (prop.collidable) {
          for (const adjecentChunk of adjecentChunks) {
            for (const adjecentProp of adjecentChunk.props) {
              if (
                adjecentProp != prop &&
                adjecentProp.collidable &&
                !checkedCollisions.includes(adjecentProp.ID)
              ) {
                const left1 = prop.positioned.posX + prop.collidable.offsetX;
                const top1 = prop.positioned.posY + prop.collidable.offsetY;
                const width1 = prop.collidable.sizeX;
                const height1 = prop.collidable.sizeY;

                const left2 =
                  adjecentProp.positioned.posX +
                  adjecentProp.collidable.offsetX;
                const top2 =
                  adjecentProp.positioned.posY +
                  adjecentProp.collidable.offsetY;
                const width2 = adjecentProp.collidable.sizeX;
                const height2 = adjecentProp.collidable.sizeY;

                const isLeft = left1 + width1 <= left2;
                const isRight = left1 >= left2 + width2;
                const isAbove = top1 + height1 <= top2;
                const isBelow = top1 >= top2 + height2;

                if (!(isLeft || isRight || isAbove || isBelow)) {
                  prop.collidable.onCollide?.(adjecentProp);
                  adjecentProp.collidable.onCollide?.(prop);
                }
              }
            }
          }
          checkedCollisions.push(prop.ID);
        }
      }
    }

    // todo this is inefficient
    this.$generateExternalEventBatch("all", "everyUpdate");
    this.tickNum++;
    this.$isProcessingTick = false;
    severityLog(`time enlapsed to calcultae stuff in tick loop ${tickLoop()}`);
  };

  private spawnPropHandler = (data: ISpawnPropEvent["data"]) => {
    const propType = propsMap[data.propName];
    if (propType) {
      const prop = new propType(this) as Prop & PropBehaviours;
      if (data.behaviours) {
        for (const [key, val] of Object.entries(data.behaviours)) {
          if (prop[key]) prop[key] = { ...prop[key], ...val };
          else prop[key] = val;
        }
      }
      this.propList.unshift(prop);
      severityLog(`created new prop ${data.propName}`);
      prop.onCreated?.(this.tickNum);
      if (prop.positioned)
        this.$appendToChunkedUpdates(
          { props: [prop], load: [prop] },
          prop as IPositioned
        );
    }
  };
  private spawnControlledPropHandler = (
    data: ISpawnControlledPropEvent["data"]
  ) => {
    const propType = propsMap[data.propName];
    if (propType) {
      const prop = new propType(data.clientID, this) as IProp & PropBehaviours;
      if (data.nameTag) prop.nameTagged = { tag: data.nameTag };
      if (prop.controlled) {
        this.propList.unshift(prop);
        severityLog(
          `created new controlled prop ${data.propName} for ${data.clientID}`
        );
        prop.onCreated?.(this.tickNum);
        this.$appendToChunkedUpdates(
          { props: [prop], load: [prop] },
          prop as IPositioned
        );
      }
    }
  };
  private destroyPropHandler = (data: IDestroyPropEvent["data"]) => {
    for (let i = 0; i < this.propList.length; i++) {
      if (this.propList[i].ID == data.ID) {
        this.$appendToChunkedUpdates(
          { delete: [data.ID] },
          this.propList[i] as IPositioned
        );
        this.propList.splice(i, 1);
        severityLog(`destroyed prop ${this.propList[i].ID}`);
        return;
      }
    }
  };
  private destroyControlledPropHandler = (
    data: IDestroyControlledPropEvent["data"]
  ) => {
    for (let i = 0; i < this.propList.length; i++) {
      if (
        (this.propList[i] as unknown as IControlled).controlled?.clientID ==
        data.clientID
      ) {
        this.$appendToChunkedUpdates(
          { delete: [this.propList[i].ID] },
          this.propList[i] as IPositioned
        );
        this.propList.splice(i, 1);
        return;
      }
    }
  };
  private clientActionHandler = (data: IClientActionEvent["data"]) => {
    const prop = this.propList.find(
      (prop) => prop.controlled?.clientID == data.clientID
    ) as IProp & IControlled;
    prop.controlled.onReceive?.(data.code, data.status);
  };

  clientAction: IScene["clientAction"] = async (clientID, code, status?) => {
    const unlock = await this.internalEventQueueMutex.acquire();
    try {
      this.internalEventQueueMutex.value.unshift({
        name: "clientAction",
        data: {
          clientID,
          code,
          status,
        },
      });
    } finally {
      unlock();
    }
  };
  connectAction: IScene["connectAction"] = async (clientID, nameTag?) => {
    const unlock = await this.internalEventQueueMutex.acquire();
    try {
      severityLog(`scene connected client ${clientID}`);
      const event = {
        name: "spawnControlledProp",
        data: {
          clientID,
          posX: 0,
          posY: 0,
          propName: "player",
        },
      } as ISpawnControlledPropEvent;
      if (nameTag) event.data.nameTag = nameTag;
      this.internalEventQueueMutex.value.unshift(event);
    } finally {
      unlock();
      this.$generateExternalEventBatch(clientID, "currentState");
    }
  };
  disconnectAction: IScene["disconnectAction"] = async (clientID) => {
    const unlock = await this.internalEventQueueMutex.acquire();
    try {
      this.internalEventQueueMutex.value.unshift({
        name: "destroyControlledProp",
        data: { clientID },
      });
    } finally {
      unlock();
    }
  };
  mutatePropBehaviourAction: IScene["mutatePropBehaviourAction"] = (
    propOrID,
    behaviour
  ) => {
    const prop =
      typeof propOrID == "string"
        ? this.propList.find((prop) => prop.ID == propOrID)
        : propOrID;
    prop[behaviour.name] = { ...prop[behaviour.name], ...behaviour.newValue };
    if (prop.positioned)
      this.$appendToChunkedUpdates(
        { update: { [prop.ID]: { [behaviour.name]: behaviour.newValue } } },
        prop as IPositioned
      );
  };
  spawnPropAction: IScene["spawnPropAction"] = async (
    propName,
    behaviours?
  ) => {
    const unlock = await this.internalEventQueueMutex.acquire();
    const event = {
      name: "spawnProp",
      data: {
        posX: 0,
        posY: 0,
        propName,
        behaviours,
      },
    } satisfies ISpawnPropEvent;
    this.internalEventQueueMutex.value.unshift(event);
    unlock();
  };
  destroyPropAction: IScene["destroyPropAction"] = async (propID) => {
    const unlock = await this.internalEventQueueMutex.acquire();
    try {
      this.internalEventQueueMutex.value.unshift({
        name: "destroyProp",
        data: { ID: propID },
      } satisfies IDestroyPropEvent);
    } finally {
      unlock();
    }
  };
  getSceneMeta: IScene["getSceneMeta"] = () => {
    return {
      name: "serverSceneMeta",
      stageSystemName: this.stage?.meta.stageSystemName,
      gridSize: this.stage?.meta.gridSize,
    };
  };

  makeSubscribe: IScene["makeSubscribe"] = (subscriber) => {
    this.eventHandler = subscriber.handlerForSceneExternalEvents;
  };

  loadTemplate = (template: ISceneTemplate) => {
    this.propList = [...template?.props];
  };

  getLayoutAt: IScene["getLayoutAt"] = (x, y) => {
    x = Math.floor(x / this.stage.meta.gridSize);
    y = Math.floor(y / this.stage.meta.gridSize);
    try {
      const layout = this.stage.layoutData.split(/\r\n|\r|\n/);
      if (layout[y][x] != " ") {
        return { solid: true };
      }
    } catch {}
    return { solid: false };
  };

  constructor(stage?: StageExt) {
    this.stage = stage;
    this.stage.layoutData;
    this.internalEventHandlerMap = {
      spawnControlledProp: this.spawnControlledPropHandler,
      spawnProp: this.spawnPropHandler,
      destroyProp: this.destroyPropHandler,
      destroyControlledProp: this.destroyControlledPropHandler,
      clientAction: this.clientActionHandler,
    };
  }
}
