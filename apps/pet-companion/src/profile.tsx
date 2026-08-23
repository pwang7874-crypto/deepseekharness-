import { useEffect, useState, type ChangeEvent } from 'react'
import { saveAvatarAsset } from './avatar-assets'

export type AvatarMode = 'builtin' | 'image' | 'model3d' | 'live2d'

export type PetProfile = {
  name: string
  introduction: string
  relationship: string
  tone: string
  systemVoice: string
  bridgeToken: string
  skinDataUrl: string
  live2dModelUrl: string
  voiceSampleDataUrl: string
  avatarMode: AvatarMode
  avatarAssetId: string
  avatarAssetName: string
}

export const defaultProfile: PetProfile = {
  name: '小深', introduction: '一只陪伴我工作、学习和生活的智能桌宠', relationship: '朋友',
  tone: '温柔、自然、简洁', systemVoice: '', bridgeToken: '', skinDataUrl: '', live2dModelUrl: '', voiceSampleDataUrl: '',
  avatarMode: 'builtin', avatarAssetId: '', avatarAssetName: '',
}

export function loadProfile(): PetProfile {
  try { return { ...defaultProfile, ...JSON.parse(localStorage.getItem('dsh-pet-profile') || '{}') } }
  catch { return defaultProfile }
}

function readSmallFile(event: ChangeEvent<HTMLInputElement>, done: (data: string) => void) {
  const file = event.target.files?.[0]
  if (!file) return
  if (file.size > 3_500_000) return window.alert('文件请控制在 3.5 MB 以内；大型 Live2D 模型请使用模型 URL。')
  const reader = new FileReader(); reader.onload = () => done(String(reader.result)); reader.readAsDataURL(file)
}

export function ProfilePanel({ value, onSave, onClose }: { value: PetProfile; onSave: (value: PetProfile) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(value)
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  useEffect(() => {
    const load = () => setVoices(window.speechSynthesis?.getVoices() ?? [])
    load(); window.speechSynthesis?.addEventListener('voiceschanged', load)
    return () => window.speechSynthesis?.removeEventListener('voiceschanged', load)
  }, [])
  const set = <K extends keyof PetProfile>(key: K, next: PetProfile[K]) => setDraft((old) => ({ ...old, [key]: next }))
  const chooseAvatar = async (event: ChangeEvent<HTMLInputElement>, mode: AvatarMode) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (file.size > 50_000_000) return window.alert('角色文件请控制在 50 MB 以内。')
    try {
      const id = await saveAvatarAsset(file)
      setDraft((old) => ({ ...old, avatarMode: mode, avatarAssetId: id, avatarAssetName: file.name, skinDataUrl: mode === 'image' ? '' : old.skinDataUrl }))
    } catch (error) { window.alert(`保存角色文件失败：${String(error)}`) }
  }
  return <aside className="profile-panel">
    <header><strong>定制我的桌宠</strong><button onClick={onClose}>×</button></header>
    <label>名字<input value={draft.name} maxLength={40} onChange={(e) => set('name', e.target.value)} /></label>
    <label>你们的关系<input list="relationship-options" value={draft.relationship} maxLength={40} onChange={(e) => set('relationship', e.target.value)} /><datalist id="relationship-options"><option value="情侣" /><option value="主仆" /><option value="朋友" /><option value="宠物" /><option value="家人" /><option value="搭档" /></datalist></label>
    <label>人物介绍<textarea value={draft.introduction} maxLength={1000} rows={3} onChange={(e) => set('introduction', e.target.value)} /></label>
    <label>说话语气<input value={draft.tone} maxLength={200} placeholder="例如：温柔、俏皮，偶尔撒娇" onChange={(e) => set('tone', e.target.value)} /></label>
    <label>系统音色<select value={draft.systemVoice} onChange={(e) => set('systemVoice', e.target.value)}><option value="">自动选择中文音色</option>{voices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} · {voice.lang}</option>)}</select></label>
    <label>DSH 连接令牌<input type="password" value={draft.bridgeToken} placeholder="与 pet-bridge.token 保持一致" onChange={(e) => set('bridgeToken', e.target.value)} /></label>
    <fieldset className="avatar-choice"><legend>人物形象</legend>
      <label className="upload">上传 JPG/PNG/GIF，自动变成动态角色<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => void chooseAvatar(e, 'image')} /><span>{draft.avatarMode === 'image' && draft.avatarAssetName ? `已选择：${draft.avatarAssetName}` : '选择人物图片'}</span></label>
      <label className="upload">上传 VRM/GLB，使用真正 3D 角色<input type="file" accept=".vrm,.glb,model/gltf-binary" onChange={(e) => void chooseAvatar(e, 'model3d')} /><span>{draft.avatarMode === 'model3d' && draft.avatarAssetName ? `已选择：${draft.avatarAssetName}` : '选择 3D 模型'}</span></label>
      <label>Live2D model3.json URL<input value={draft.live2dModelUrl} placeholder="http://127.0.0.1:…/model3.json" onChange={(e) => { set('live2dModelUrl', e.target.value); if (e.target.value) set('avatarMode', 'live2d') }} /></label>
      <button type="button" className="builtin-choice" onClick={() => set('avatarMode', 'builtin')}>恢复内置小深</button>
      <p className="hint">普通图片会自动加入呼吸、点头、情绪和说话动作；VRM/GLB 含网格与骨骼，可显示真实三维动画。</p>
    </fieldset>
    <label className="upload">上传音色参考<input type="file" accept="audio/*" onChange={(e) => readSmallFile(e, (data) => set('voiceSampleDataUrl', data))} /><span>{draft.voiceSampleDataUrl ? '已保存音色样本' : '选择音频'}</span></label>
    <p className="hint">音色样本保存在本机，供后续兼容的 TTS 服务使用；当前朗读使用所选系统音色。</p>
    <footer><button className="preview" onClick={() => draft.voiceSampleDataUrl && new Audio(draft.voiceSampleDataUrl).play()}>试听样本</button><button className="save" onClick={() => onSave(draft)}>保存设定</button></footer>
  </aside>
}
