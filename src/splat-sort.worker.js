let positions;
self.onmessage=({data})=>{
 if(data.positions){if(!positions||positions.length!==data.capacity)positions=new Float32Array(data.capacity);positions.set(data.positions,data.start||0);}
 if(!data.order)return;
 const {order,matrix:m,eye,key}=data,distances=new Float64Array(positions.length/3);
 for(const id of order){const x=positions[id*3],y=positions[id*3+1],z=positions[id*3+2],w=1/(m[3]*x+m[7]*y+m[11]*z+m[15]);const dx=(m[0]*x+m[4]*y+m[8]*z+m[12])*w-eye[0],dy=(m[1]*x+m[5]*y+m[9]*z+m[13])*w-eye[1],dz=(m[2]*x+m[6]*y+m[10]*z+m[14])*w-eye[2];distances[id]=dx*dx+dy*dy+dz*dz;}
 order.sort((a,b)=>distances[b]-distances[a]||a-b);self.postMessage({order,key},[order.buffer]);
};
