import { MeshPhysicalMaterial, Color, SRGBColorSpace, ShaderChunk } from 'three';
const slots=['diffuseTransmissionMap','diffuseTransmissionColorMap'];
// Keep actual Texture objects in material fields: the PAX image alias tracker
// then refines these exactly like baseColor/normal maps, including variants.
export class DiffuseTransmissionMaterial extends MeshPhysicalMaterial {
  constructor(parameters) {
    super(); this.diffuseTransmission=0;this.diffuseTransmissionColor=new Color(1,1,1);
    for(const slot of slots)this[slot]=null;
    this.setValues(parameters);
  }
  copy(source){super.copy(source);this.diffuseTransmission=source.diffuseTransmission;this.diffuseTransmissionColor.copy(source.diffuseTransmissionColor);for(const slot of slots)this[slot]=source[slot];return this;}
  customProgramCacheKey(){return 'pax-diffuse-transmission:'+slots.map(s=>this[s]?.channel??'-').join(':');}
  onBeforeCompile(shader) {
    const material=this;
    const uniform=(name,get)=>{shader.uniforms[name]={get value(){return get();}};};
    uniform('paxDTFactor',()=>material.diffuseTransmission);uniform('paxDTColor',()=>material.diffuseTransmissionColor);
    let declarations='uniform float paxDTFactor; uniform vec3 paxDTColor; float paxDT; vec3 paxDTColour; vec3 paxBackIrradiance; vec3 paxBackIBL;\n';
    let setup='paxDT=paxDTFactor; paxDTColour=paxDTColor;\n';
    let vertexDeclarations='',vertexSetup='';
    slots.forEach((slot,i)=>{
      const texture=this[slot];if(!texture)return;
      const uv=texture.channel===0?'uv':`uv${texture.channel}`;
      uniform(`paxDTMap${i}`,()=>material[slot]);uniform(`paxDTTransform${i}`,()=>{material[slot].updateMatrix();return material[slot].matrix;});
      // WebGLRenderer already declares uv..uv3. Extra sets are declared by geometryFeatures.
      vertexDeclarations+=`uniform mat3 paxDTTransform${i}; varying vec2 paxDTUv${i};\n`;
      vertexSetup+=`paxDTUv${i}=(paxDTTransform${i}*vec3(${uv},1.)).xy;\n`;
      declarations+=`uniform sampler2D paxDTMap${i}; varying vec2 paxDTUv${i};\n`;
      setup+=i===0?`paxDT*=texture2D(paxDTMap0,paxDTUv0).a;\n`:`paxDTColour*=texture2D(paxDTMap1,paxDTUv1).rgb;\n`;
    });
    // Volume attenuates the transmitted color; material thickness textures use G.
    uniform('paxDTThickness',()=>material.thickness);uniform('paxDTDistance',()=>material.attenuationDistance);uniform('paxDTAttenuation',()=>material.attenuationColor);
    declarations+='uniform float paxDTThickness; uniform float paxDTDistance; uniform vec3 paxDTAttenuation;\n';
    setup+='paxDT=clamp(paxDT,0.,1.); float paxThickness=paxDTThickness;\n';
    if(this.thicknessMap){uniform('paxDTThicknessMap',()=>material.thicknessMap);uniform('paxDTThicknessTransform',()=>{material.thicknessMap.updateMatrix();return material.thicknessMap.matrix;});const uv=this.thicknessMap.channel?`uv${this.thicknessMap.channel}`:'uv';vertexDeclarations+='uniform mat3 paxDTThicknessTransform; varying vec2 paxDTThicknessUv;\n';vertexSetup+=`paxDTThicknessUv=(paxDTThicknessTransform*vec3(${uv},1.)).xy;\n`;declarations+='uniform sampler2D paxDTThicknessMap; varying vec2 paxDTThicknessUv;\n';setup+='paxThickness*=texture2D(paxDTThicknessMap,paxDTThicknessUv).g;\n';}
    setup+='if(paxThickness>0. && paxDTDistance>0.) paxDTColour*=pow(paxDTAttenuation,vec3(paxThickness/paxDTDistance));\n';
    shader.vertexShader=vertexDeclarations+shader.vertexShader.replace('#include <uv_vertex>','#include <uv_vertex>\n'+vertexSetup);
    let physical=ShaderChunk.lights_physical_pars_fragment;
    physical=physical.replace('reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );',`reflectedLight.directDiffuse += irradiance * BRDF_Lambert(material.diffuseContribution) * (1.-F) * (1.-paxDT);
      vec3 backLight=directLight.color * saturate(-dot(geometryNormal,directLight.direction));
      #ifdef USE_SHEEN
      backLight*=sheenEnergyComp;
      #endif
      vec3 backHalf=normalize(-directLight.direction+geometryViewDir);
      vec3 backF=F_Schlick(material.specularColor,material.specularF90,saturate(dot(geometryViewDir,backHalf)));
      reflectedLight.directDiffuse += backLight * BRDF_Lambert(paxDTColour*(1.-material.metalness)) * (1.-backF) * paxDT;`);
    physical=physical.replace('vec3 diffuse = irradiance * BRDF_Lambert( material.diffuseContribution )', 'vec3 diffuse = (irradiance * BRDF_Lambert(material.diffuseContribution) * (1.-paxDT) + paxBackIrradiance * BRDF_Lambert(paxDTColour*(1.-material.metalness)) * paxDT)');
    physical=physical.replace('vec3 indirectDiffuse = diffuse * cosineWeightedIrradiance;', 'vec3 indirectDiffuse = diffuse * cosineWeightedIrradiance * (1.-paxDT) + paxDTColour*(1.-material.metalness)*(1.-totalScatteringDielectric)*paxBackIBL*RECIPROCAL_PI*paxDT;');
    physical=physical.replace('reflectedLight.directDiffuse += lightColor * material.diffuseContribution * LTC_Evaluate( normal, viewDir, position, mat3( 1.0 ), rectCoords );', 'reflectedLight.directDiffuse += lightColor * (material.diffuseContribution * LTC_Evaluate(normal,viewDir,position,mat3(1.),rectCoords)*(1.-paxDT) + paxDTColour*(1.-material.metalness)*LTC_Evaluate(-normal,viewDir,position,mat3(1.),rectCoords)*paxDT);');
    const back=`paxBackIrradiance=getAmbientLightIrradiance(ambientLightColor);paxBackIBL=vec3(0.);
#ifdef USE_LIGHT_PROBES
paxBackIrradiance+=getLightProbeIrradiance(lightProbe,-geometryNormal);
#endif
#if NUM_HEMI_LIGHTS > 0
for(int paxI=0;paxI<NUM_HEMI_LIGHTS;paxI++){paxBackIrradiance+=getHemisphereLightIrradiance(hemisphereLights[paxI],-geometryNormal);}
#endif
#if defined(USE_ENVMAP) && defined(ENVMAP_TYPE_CUBE_UV)
paxBackIBL=getIBLIrradiance(-geometryNormal);
#endif
`;
    shader.fragmentShader=declarations+shader.fragmentShader.replace('#include <lights_physical_pars_fragment>',physical).replace('#include <lights_physical_fragment>',setup+'\n#include <lights_physical_fragment>').replace('#include <lights_fragment_end>',back+'\n#include <lights_fragment_end>');
  }
}
export function diffuseTransmission(parser){return {name:'KHR_materials_diffuse_transmission',getMaterialType(index){if(parser.json.materials[index].extensions?.KHR_materials_diffuse_transmission)return DiffuseTransmissionMaterial;return null;},async extendMaterialParams(index,params){const ext=parser.json.materials[index].extensions?.KHR_materials_diffuse_transmission;if(!ext)return;params.defines={...(params.defines||{})};for(const info of [ext.diffuseTransmissionTexture,ext.diffuseTransmissionColorTexture,parser.json.materials[index].extensions?.KHR_materials_volume?.thicknessTexture]){const uv=info?.extensions?.KHR_texture_transform?.texCoord??info?.texCoord;if(uv>0&&uv<4)params.defines[`USE_UV${uv}`]='';}params.diffuseTransmission=ext.diffuseTransmissionFactor??0;params.diffuseTransmissionColor=new Color().fromArray(ext.diffuseTransmissionColorFactor??[1,1,1]);await Promise.all([ext.diffuseTransmissionTexture&&parser.assignTexture(params,slots[0],ext.diffuseTransmissionTexture),ext.diffuseTransmissionColorTexture&&parser.assignTexture(params,slots[1],ext.diffuseTransmissionColorTexture,SRGBColorSpace)]);}};}
