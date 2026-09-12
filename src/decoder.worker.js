import {decodePacket} from './format.js';
import {mergeAxis,unfilterRows} from './textures.js';
import {refineTile} from './texture-tiles.js';
const images=new Map();
self.onmessage=async({data:{id,op,args}})=>{try{let value;if(op==='packet')value=await decodePacket(args.entry,args.bytes);else if(op==='lattice')value=mergeAxis(args.pixels,args.width,args.height,unfilterRows(args.filtered,args.width,args.height),args.axis);else if(op==='tile-init'){images.set(args.image,{...args,tiles:new Map()});value=new Uint8Array(0);}else if(op==='tile')value=refineTile(images.get(args.meta.image),args.meta,args.filtered);else throw new Error('Unknown decode operation');self.postMessage({id,value},[value.buffer]);}catch(error){self.postMessage({id,error:error.message});}};
