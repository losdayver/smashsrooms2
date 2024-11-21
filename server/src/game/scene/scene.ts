import { ClientActionCodes } from "../sockets/messageMeta";
import {
  IDestroyControlledPropEvent,
  IDestroyPropEvent,
  IInternalEvent,
  IScene,
  ISceneSubscriber,
  ISceneTemplate,
  ISpawnControlledPropEvent,
  ISpawnPropEvent,
} from "./sceneTypes";
import { Mutex, severityLog, PickOne } from "./../../utils";
import { Prop, propsMap } from "./props";
import { IControlled, IProp, PropBehaviours } from "./propTypes";

export class Scene implements IScene {
  eventHandler: ISceneSubscriber["handlerForSceneEventsEvents"];

  private chunkSize = 256;

  private propList: (Prop & PropBehaviours)[] = []; // todo wrap it up in mutex
  private internalEventQueueMutex = new Mutex<IInternalEvent[]>([]);
  private internalEventHandlerMap: Record<
    IInternalEvent["name"],
    (data: any) => void
  >;

  mutatePropBehaviour = (
    propOrID: (IProp & PropBehaviours) | string,
    behaviour: { name: string; newValue: PropBehaviours }
  ) => {
    const prop =
      typeof propOrID == "string"
        ? this.propList.find((prop) => prop.ID == propOrID)
        : propOrID;
    prop[behaviour.name] = behaviour.newValue;
    // todo external event factory
  };

  private _singleTickChunkDivisions: Record<
    string,
    {
      props: IProp[];
      update: Record<string, IProp & PropBehaviours>;
      load: IProp[];
      delete: string[];
    }
  >[] = [];

  tick = async () => {
    this._singleTickChunkDivisions = [];
    this.propList.forEach((prop) => {
      if (prop.positioned) {
        const coordID = `${Math.floor(
          prop.positioned.posX / this.chunkSize
        )}_${Math.floor(prop.positioned.posY / this.chunkSize)}`;
        if (!this._singleTickChunkDivisions[coordID])
          this._singleTickChunkDivisions[coordID] = {
            props: [prop],
            update: {},
            load: {},
            delete: {},
          };
        else this._singleTickChunkDivisions[coordID].props.push(prop);
      }
    });

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
  };
  spawnPropHandler = (data: ISpawnPropEvent["data"]) => {
    const propType = propsMap[data.propName];
    if (propType) {
      const prop = new propType(this) as IProp & PropBehaviours;
      this.propList.unshift(prop);
      severityLog(`created new prop ${data.propName}`);
      if (prop.positioned) {
        const coordID = `${Math.floor(
          prop.positioned.posX / this.chunkSize
        )}_${Math.floor(prop.positioned.posY / this.chunkSize)}`;
        if (!this._singleTickChunkDivisions[coordID])
          this._singleTickChunkDivisions[coordID] = {
            props: [],
            update: {},
            load: [prop],
            delete: {},
          };
        else this._singleTickChunkDivisions[coordID].load.push(prop);
      }
    }
  };
  spawnControlledPropHandler = (data: ISpawnControlledPropEvent["data"]) => {
    const propType = propsMap[data.propName];
    if (propType) {
      const prop = new propsMap[data.propName](data.clientID, this) as Prop;
      if ((prop as unknown as IControlled).controlled) {
        this.propList.unshift(prop);
        severityLog(
          `created new controlled prop ${data.propName} for ${data.clientID}`
        );
      }
    }
  };
  destroyPropHandler = (data: IDestroyPropEvent["data"]) => {
    for (let i = 0; i < this.propList.length; i++) {
      if (this.propList[i].ID == data.ID) {
        this.propList.splice(i, 1);
      }
      severityLog(`destroyed prop ${this.propList[i].ID}`);
      return;
    }
  };
  destroyControlledPropHandler = (
    data: IDestroyControlledPropEvent["data"]
  ) => {
    for (let i = 0; i < this.propList.length; i++) {
      if (
        (this.propList[i] as unknown as IControlled)?.controlled.clientID ==
        data.clientID
      ) {
        severityLog(
          `destroyed controlled prop with clientID ${
            (this.propList[i] as unknown as IControlled)?.controlled.clientID
          }`
        );
        this.propList.splice(i, 1);
      }
      return;
    }
  };

  clientAction = (clientID: string, code: ClientActionCodes) => {
    severityLog(`client ${clientID} preformed action ${code}`);
  };
  connectAction = async (clientID: string) => {
    const unlock = await this.internalEventQueueMutex.acquire();
    try {
      severityLog(`scene connected client ${clientID}`);
      this.internalEventQueueMutex.value.unshift({
        name: "spawnControlledProp",
        data: {
          clientID,
          posX: 0,
          posY: 0,
          propName: "player",
        },
      });
    } finally {
      unlock();
    }
  };
  disconnectAction = async (clientID: string) => {
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

  makeSubscribe = (subscriber: ISceneSubscriber) => {
    this.eventHandler = subscriber.handlerForSceneEventsEvents;
  };

  loadTemplate = (template: ISceneTemplate) => {
    this.propList = [...template?.props];
  };

  constructor() {
    this.internalEventHandlerMap = {
      spawnControlledProp: this.spawnControlledPropHandler,
      spawnProp: this.spawnPropHandler,
      destroyProp: this.destroyPropHandler,
      destroyControlledProp: this.destroyControlledPropHandler,
    };
  }
}
