export function registerContentHashConformance<T>(options:{
 name:string;clientSerialize:(value:T)=>string;serverSerialize:(value:T)=>string;
 equivalent:Array<{name:string;values:T[];expected:string}>;
 different:Array<{name:string;left:T;right:T}>;
}):void;
