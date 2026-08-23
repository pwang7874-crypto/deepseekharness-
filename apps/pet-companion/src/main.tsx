import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalSize } from '@tauri-apps/api/dpi'
import { open } from '@tauri-apps/plugin-dialog'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { defaultProfile, loadProfile, ProfilePanel, type PetProfile } from './profile'
import { shouldKeepCurrentBubble, speechTuning, type Emotion } from './personality'
import type { PetEvent } from './types'
import { AvatarStage } from './AvatarStage'
import { startMicrophoneRecording, transcribeRecording } from './speech-input'
import { actionDuration, actionForEmotion, chooseAutonomousAction, type PetAction } from './pet-life'
import './styles.css'

const bridgeUrl = import.meta.env.VITE_DSH_PET_BRIDGE ?? 'http://127.0.0.1:3080/dsh-pet/events'
const fallbackBridgeToken = import.meta.env.VITE_DSH_PET_TOKEN ?? 'change-me-before-production'
const runningInTauri = () => isTauri()

type BootstrapState = 'checking' | 'ready' | 'missing-dsh' | 'restart-required' | 'failed'
type BootstrapReport = { state: BootstrapState; message: string; dshPath?: string; detail?: string }
const normalizeScale = (value: number) => Number.isFinite(value) ? Math.max(0.65, Math.min(1.65, value)) : 1

function playTouchSound(enabled: boolean, playful = false) {
  if (!enabled) return
  try {
    const context = new AudioContext(); const oscillator = context.createOscillator(); const gain = context.createGain()
    oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(playful ? 660 : 520, context.currentTime)
    oscillator.frequency.exponentialRampToValueAtTime(playful ? 920 : 690, context.currentTime + 0.1)
    gain.gain.setValueAtTime(0.0001, context.currentTime); gain.gain.exponentialRampToValueAtTime(0.09, context.currentTime + 0.015); gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.16)
    oscillator.connect(gain).connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + 0.17)
    oscillator.onended = () => void context.close()
  } catch { /* Touch feedback must never interrupt the interaction itself. */ }
}

function speak(text: string, emotion: Emotion, intensity: number, profile: PetProfile) {
  if (!('speechSynthesis' in window) || !text) return
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  const tuning = speechTuning(emotion, profile.tone, intensity)
  utterance.lang = 'zh-CN'
  utterance.voice = window.speechSynthesis.getVoices().find((voice) => voice.voiceURI === profile.systemVoice) ?? null
  utterance.rate = tuning.rate
  utterance.pitch = tuning.pitch
  utterance.volume = tuning.volume
  window.speechSynthesis.speak(utterance)
}

function App() {
  const [emotion, setEmotion] = useState<Emotion>('neutral')
  const [intensity, setIntensity] = useState(0.45)
  const [message, setMessage] = useState('连接 DeepSeek Harness 中…')
  const [connected, setConnected] = useState(false)
  const [profile, setProfile] = useState<PetProfile>(() => loadProfile())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [bootstrap, setBootstrap] = useState<BootstrapReport>({ state: 'checking', message: '正在一键配置桌宠插件…' })
  const [scale, setScale] = useState(() => normalizeScale(Number(localStorage.getItem('dsh-pet-scale') || 1)))
  const [micState, setMicState] = useState<'idle' | 'listening' | 'loading' | 'transcribing' | 'sending'>('idle')
  const [petAction, setPetAction] = useState<PetAction>('idle')
  const [look, setLook] = useState({ x: 0, y: 0 })
  const [touchBurst, setTouchBurst] = useState(0)
  const [quickMenu, setQuickMenu] = useState(false)
  const resetTimer = useRef<number>()
  const actionTimer = useRef<number>()
  const lifeTimer = useRef<number>()
  const touchTimer = useRef<number>()
  const lastInteraction = useRef(Date.now())
  const recording = useRef<Awaited<ReturnType<typeof startMicrophoneRecording>>>()
  const speaking = emotion === 'speaking' || emotion === 'happy' || emotion === 'gentle'
  const bridgeToken = profile.bridgeToken || fallbackBridgeToken
  const eventSourceUrl = useMemo(() => `${bridgeUrl}${bridgeUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(bridgeToken)}`, [bridgeToken])
  const profileUrl = useMemo(() => `${bridgeUrl.replace(/\/events(?:\?.*)?$/, '/profile')}?token=${encodeURIComponent(bridgeToken)}`, [bridgeToken])
  const chatUrl = useMemo(() => `${bridgeUrl.replace(/\/events(?:\?.*)?$/, '/chat')}?token=${encodeURIComponent(bridgeToken)}`, [bridgeToken])
  const characterProfile = useMemo(() => ({
    name: profile.name,
    introduction: profile.introduction,
    relationship: profile.relationship,
    tone: profile.tone,
  }), [profile.name, profile.introduction, profile.relationship, profile.tone])

  const runBootstrap = useCallback(async (dshPath?: string) => {
    if (!runningInTauri()) {
      setBootstrap({ state: 'ready', message: '浏览器预览模式' })
      setConnected(true)
      setMessage('浏览器预览模式 · 桌面功能将在安装包中启用')
      return
    }
    setBootstrap({ state: 'checking', message: '正在一键配置桌宠插件…' })
    setConnected(false)
    try {
      const report = await invoke<BootstrapReport>('ensure_dsh_plugin', { dshPath: dshPath ?? null })
      setBootstrap(report)
      setMessage(report.message)
    } catch (error) {
      const report = { state: 'failed' as const, message: '自动配置没有完成，请重试。', detail: String(error) }
      setBootstrap(report)
      setMessage(report.message)
    }
  }, [])

  useEffect(() => { void runBootstrap() }, [runBootstrap])
  useEffect(() => { if (runningInTauri()) void getCurrentWindow().setSize(new LogicalSize(Math.round(280 * scale), Math.round(330 * scale))) }, [])
  useEffect(() => {
    const syncToWindow = () => {
      const next = normalizeScale(Math.min(window.innerWidth / 280, window.innerHeight / 330))
      setScale(next); localStorage.setItem('dsh-pet-scale', String(next))
    }
    window.addEventListener('resize', syncToWindow)
    return () => window.removeEventListener('resize', syncToWindow)
  }, [])

  const chooseDsh = async () => {
    if (!runningInTauri()) return
    const selected = await open({ title: '选择 DSH Desktop.app 或 dsh 可执行文件', multiple: false, directory: false })
    if (typeof selected === 'string') await runBootstrap(selected)
  }

  const needsDshPicker = bootstrap.state === 'missing-dsh' || (bootstrap.state === 'failed' && !bootstrap.dshPath)

  const beginWindowDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || settingsOpen) return
    const target = event.target as HTMLElement
    if (!target.closest('.quick-menu')) setQuickMenu(false)
    if (!target.closest('.drag-handle') || target.closest('button,input,textarea,select,label,a,[role="dialog"]')) return
    if (runningInTauri()) void getCurrentWindow().startDragging()
  }

  const triggerAction = useCallback((action: PetAction) => {
    if (actionTimer.current) window.clearTimeout(actionTimer.current)
    setPetAction(action)
    const duration = actionDuration(action)
    if (duration) actionTimer.current = window.setTimeout(() => setPetAction('idle'), duration)
  }, [])

  useEffect(() => {
    if (!profile.autonomousMotion || settingsOpen || micState !== 'idle') return
    let alive = true
    const schedule = () => {
      if (!alive) return
      lifeTimer.current = window.setTimeout(() => {
        if (!alive) return
        if (emotion === 'neutral') triggerAction(chooseAutonomousAction({ hour: new Date().getHours(), inactiveMs: Date.now() - lastInteraction.current, connected }))
        schedule()
      }, 9000 + Math.random() * 9000)
    }
    schedule()
    return () => { alive = false; if (lifeTimer.current) window.clearTimeout(lifeTimer.current) }
  }, [connected, emotion, micState, profile.autonomousMotion, settingsOpen, triggerAction])

  useEffect(() => {
    if (!runningInTauri()) return
    // Only the text persona crosses the loopback bridge. Local skins, samples,
    // system voice choices, and the authentication token stay in this app.
    void fetch(profileUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(characterProfile) }).catch(() => {})
  }, [profileUrl, characterProfile])

  useEffect(() => {
    if (bootstrap.state !== 'ready' || !runningInTauri()) return
    // EventSource cannot attach custom headers. The bridge also accepts the query token for native companions.
    const source = new EventSource(eventSourceUrl)
    source.onopen = () => { setConnected(true); setMessage('已连接到 DeepSeek Harness') }
    source.onerror = () => { setConnected(false); setMessage('等待 DeepSeek Harness 事件桥接…') }
    source.addEventListener('pet', async (raw) => {
      const event = JSON.parse((raw as MessageEvent).data) as PetEvent
      const level = event.intensity ?? 0.6
      const answerStillSpeaking = shouldKeepCurrentBubble(event, window.speechSynthesis.speaking)
      setEmotion(event.emotion); setIntensity(level)
      const mappedAction = actionForEmotion(event.emotion); if (mappedAction !== 'idle') triggerAction(mappedAction)
      if (!answerStillSpeaking) setMessage(event.text ?? '')
      if (resetTimer.current) window.clearTimeout(resetTimer.current)
      resetTimer.current = window.setTimeout(() => setEmotion('neutral'), event.type === 'task-complete' ? 9000 : 3500)
      if (event.text && !answerStillSpeaking) speak(event.text, event.emotion, level, profile)
      if (event.type === 'task-complete') {
        triggerAction('celebrate')
        if (runningInTauri()) {
          const granted = await isPermissionGranted()
          if (granted || await requestPermission() === 'granted') sendNotification({ title: 'DSH 任务已完成', body: event.text ?? '小桌宠在等你查看结果。' })
        }
      } else if (event.type === 'task-error') triggerAction('surprise')
    })
    return () => { source.close(); if (resetTimer.current) window.clearTimeout(resetTimer.current) }
  }, [bootstrap.state, eventSourceUrl, profile, triggerAction])

  const saveProfile = async (next: PetProfile) => {
    setProfile(next); localStorage.setItem('dsh-pet-profile', JSON.stringify(next)); setSettingsOpen(false)
  }

  const resizePet = async (delta: number) => {
    const next = normalizeScale(Math.round((scale + delta) * 10) / 10)
    setScale(next); localStorage.setItem('dsh-pet-scale', String(next))
    if (runningInTauri()) await getCurrentWindow().setSize(new LogicalSize(Math.round(280 * next), Math.round(330 * next)))
  }

  const finishMicrophone = useCallback(async (active: Awaited<ReturnType<typeof startMicrophoneRecording>>) => {
    if (recording.current !== active) return
    recording.current = undefined
    setMicState('transcribing'); setMessage('正在识别你刚才说的话…'); setEmotion('thinking'); triggerAction('tilt')
    try {
      const blob = await active.stop()
      const text = await transcribeRecording(blob, (state) => {
        setMicState(state); setMessage(state === 'loading' ? '首次使用：正在下载并缓存本地语音模型…' : '正在把语音转换成文字…')
      })
      if (!text) throw new Error('没有识别到清晰语音，请靠近麦克风再试一次。')
      setMicState('sending'); setMessage(`你说：${text}`)
      const response = await fetch(chatUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || `DSH 拒绝了语音消息（${response.status}）`)
      setMessage(`已发送：${text}`); setEmotion('thinking')
    } catch (error) { setMessage(String(error).replace(/^Error:\s*/, '')); setEmotion('error'); triggerAction('surprise') }
    finally { setMicState('idle') }
  }, [chatUrl, triggerAction])

  const toggleMicrophone = async () => {
    if (micState === 'listening' && recording.current) {
      await finishMicrophone(recording.current)
      return
    }
    if (micState !== 'idle') return
    try {
      window.speechSynthesis.cancel()
      const active = await startMicrophoneRecording(); recording.current = active
      setMicState('listening'); setEmotion('listening'); triggerAction('surprise')
      setMessage(profile.handsFreeVoice ? '我在听，说完停一下就会自动发送…' : '我在听，讲完后再点一次麦克风…')
      if (profile.handsFreeVoice) void active.speechEnded.then(() => { if (recording.current === active) void finishMicrophone(active) })
    } catch (error) { setMessage(`无法使用麦克风：${String(error).replace(/^Error:\s*/, '')}`); setEmotion('error') }
  }

  const interactWithPet = (action: PetAction, text: string, playful = false) => {
    lastInteraction.current = Date.now(); setQuickMenu(false); setTouchBurst((value) => value + 1)
    triggerAction(action); setEmotion(action === 'sleep' ? 'gentle' : 'happy'); setMessage(text); playTouchSound(profile.touchSounds, playful)
    if (resetTimer.current) window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setEmotion('neutral'), actionDuration(action) || 1800)
  }

  const updateLook = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    setLook({ x: Math.max(-1, Math.min(1, (event.clientX - bounds.left) / bounds.width * 2 - 1)), y: Math.max(-1, Math.min(1, (event.clientY - bounds.top) / bounds.height * 2 - 1)) })
  }

  const touchPetAt = (event: ReactMouseEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const upperBody = (event.clientY - bounds.top) / bounds.height < 0.58
    if (touchTimer.current) window.clearTimeout(touchTimer.current)
    touchTimer.current = window.setTimeout(() => {
      touchTimer.current = undefined
      if (upperBody) interactWithPet('nuzzle', '嘿嘿，被你摸到啦 ♡')
      else interactWithPet('wiggle', '呀，好痒呀～', true)
    }, 220)
  }

  const playWithPet = () => {
    if (touchTimer.current) window.clearTimeout(touchTimer.current)
    touchTimer.current = undefined
    interactWithPet('celebrate', '好耶！一起玩一会儿吧 ✦', true)
  }

  useEffect(() => () => {
    const active = recording.current; recording.current = undefined; active?.cancel()
    if (actionTimer.current) window.clearTimeout(actionTimer.current)
    if (lifeTimer.current) window.clearTimeout(lifeTimer.current)
    if (touchTimer.current) window.clearTimeout(touchTimer.current)
  }, [])

  return <main className="stage" data-connected={connected} onPointerDown={beginWindowDrag}><div className="pet-shell" style={{ '--pet-scale': scale } as CSSProperties}>
    <div className="ambient-decor" aria-hidden><i>♥</i><i>✦</i><i>●</i><i>✧</i><i>♥</i></div>
    <div className="drag-handle" data-tauri-drag-region title="按住拖动桌宠"><i /><i /><i /></div>
    <div className={`avatar-stage action-${petAction}`} role="button" tabIndex={0} aria-label={`摸摸${profile.name || defaultProfile.name}`} onPointerMove={updateLook} onPointerLeave={() => setLook({ x: 0, y: 0 })} onClick={touchPetAt} onDoubleClick={playWithPet} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') interactWithPet('nuzzle', '摸摸收到啦 ♡') }} onContextMenu={(event) => { event.preventDefault(); setQuickMenu(true) }} onWheel={(event) => { event.preventDefault(); void resizePet(event.deltaY > 0 ? -0.1 : 0.1) }} style={{ '--look-x': `${look.x * 4}px`, '--look-y': `${look.y * 3}px` } as CSSProperties}>
      <AvatarStage profile={profile} emotion={emotion} intensity={intensity} speaking={speaking} look={look} />
      {touchBurst > 0 && <div className="touch-hearts" key={touchBurst} aria-hidden><i>♥</i><i>♡</i><i>♥</i></div>}
    </div>
    {quickMenu && <aside className="quick-menu" role="dialog" aria-label="桌宠互动菜单">
      <strong>和{profile.name || defaultProfile.name}互动</strong>
      <button onClick={() => interactWithPet('nuzzle', '最喜欢你的摸摸啦 ♡')}>♡ 摸摸</button>
      <button onClick={() => interactWithPet('celebrate', '一起来玩！', true)}>✦ 玩耍</button>
      <button onClick={() => interactWithPet('stretch', '唔——伸个懒腰～')}>☁ 伸懒腰</button>
      <button onClick={() => interactWithPet('sleep', '晚安，我眯一小会儿…')}>☾ 小睡</button>
      <button onClick={() => { setQuickMenu(false); setSettingsOpen(true) }}>⚙ 角色设置</button>
    </aside>}
    {bootstrap.state !== 'ready' && bootstrap.state !== 'checking' && <button
      className="bootstrap-action"
      title={bootstrap.detail}
      onClick={() => needsDshPicker ? void chooseDsh() : void runBootstrap(bootstrap.dshPath)}
    >{bootstrap.state === 'restart-required' ? '我已重启，重新检测' : needsDshPicker ? '选择 DSH 并自动安装' : '重试自动安装'}</button>}
    <section className="bubble"><strong><b aria-hidden>♡</b>{profile.name || defaultProfile.name}<em>{connected ? '陪伴中' : '连接中'}</em></strong><span title={bootstrap.detail}><i className="status-dot" />{message}</span></section>
    <button className="mute" onClick={() => window.speechSynthesis.cancel()} title="停止朗读">♪</button>
    <button className={`microphone mic-${micState}`} disabled={bootstrap.state !== 'ready'} onClick={() => void toggleMicrophone()} title={micState === 'listening' ? '停止录音并发送' : '语音输入'}>{micState === 'listening' ? '■' : '🎙'}</button>
    <div className="scale-controls"><button onClick={() => void resizePet(-0.1)} title="缩小桌宠"><span>−</span></button><button onClick={() => void resizePet(0.1)} title="放大桌宠"><span>＋</span></button></div>
    <button className="close" onClick={() => { if (runningInTauri()) void getCurrentWindow().close() }} title="退出桌宠">×</button>
    <button className="settings" onClick={() => setSettingsOpen(true)} title="角色设置">⚙</button>
    {settingsOpen && <ProfilePanel value={profile} onSave={saveProfile} onClose={() => setSettingsOpen(false)} />}
  </div></main>
}

createRoot(document.getElementById('root')!).render(<App />)
