import { IExternalEvent } from "./sceneTypes";

export interface IConnectMessageExt {
  name: "conn";
  clientName: string;
}
export interface IConnectResponseMessageExt {
  name: "connRes";
  status: "allowed" | "restricted";
  cause?: string;
  clientID?: string;
  nameTag?: string;
}

export interface IDisconnectMessageExt {
  name: "disc";
  clientID: string;
}

export interface IGenericNotRegisteredResponseMessageExt {
  name: "notReg";
}

export interface ISceneUpdatesMessageExt {
  name: "scene";
  clientID: string;
  data: IExternalEvent;
}

export interface IGenericMessageExt {
  name: string;
  clientID: string;
  data: any;
}

export type IMessageExt =
  | IConnectMessageExt
  | IConnectResponseMessageExt
  | IDisconnectMessageExt
  | IGenericNotRegisteredResponseMessageExt
  | ISceneUpdatesMessageExt;

export interface IClientActionMessageExt extends IGenericMessageExt {
  name: "clientAct";
  data: {
    code: ClientActionCodesExt;
  };
}
export type ClientActionCodesExt = "left" | "right" | "jump" | "fire" | "duck";
export type ClientActionStatusExt = "pressed" | "released";
export interface IGenericResponseMessageExt {
  data: any;
}
