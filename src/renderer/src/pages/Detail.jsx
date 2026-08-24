import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useApp } from '../store/AppContext'
import WindowControls from '../components/WindowControls'
import {
  formatTime,
  progressPct,
  nextEpisode,
  shortDate
} from '../lib/format'
import Poster from '../components/Poster'
import './Detail.css'

const TABS = [
  { key: 'episodes', label: '剧集列表' },
  { key: 'info', label: '详情信息' },
  { key: 'related', label: '相关推荐' },
  { key: 'comments', label: '评论' }
]

export default function Detail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { library, getAnime, updateAnime, setWatched } = useApp()

  const anime = getAnime(id)

  // 本地交互状态
  const [tab, setTab] = useState('episodes')
  const [fav, setFav] = useState(false)
  const [season, setSeason] = useState(null)
  const [editOpen, setEditOpen] = useState(false)
  const [formDesc, setFormDesc] = useState('')
  const [formRating, setFormRating] = useState('')

  // 切番剧时重置收藏与季选择
  useEffect(() => {
    setFav(Boolean(anime?.isFavorite))
    setSeason(null)
    setTab('episodes')
  }, [anime?.id])

  if (!anime) {
    return (
      <div className="detail-page">
        <header className="ds-wbtitlebar">
          <div className="ds-wbtitlebar__left">
            <button className="titlebar-back" aria-label="返回" onClick={() => navigate(-1)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
            <span className="ds-wbtitlebar__title">未找到番剧</span>
          </div>
          <div className="ds-wbtitlebar__right">
            <WindowControls />
          </div>
        </header>
        <div className="detail-empty">未找到该番剧</div>
      </div>
    )
  }

  // 季分组
  const seasons = [...new Set((anime.episodes || []).map((e) => e.season).filter((s) => s != null))]
    .sort((a, b) => a - b)
  const activeSeason = season ?? (seasons.length ? seasons[0] : null)
  const episodes = (anime.episodes || [])
    .filter((e) => (seasons.length ? e.season === activeSeason : true))
    .sort((a, b) => a.number - b.number)

  const totalEpisodes = (anime.episodes || []).length
  const watchedCount = (anime.episodes || []).filter((e) => e.watched).length
  const pct = progressPct(anime)
  const cont = nextEpisode(anime)
  const rating = anime.rating || 0

  const toggleFav = () => {
    const next = !fav
    setFav(next)
    updateAnime(anime.id, { isFavorite: next })
  }
  const openEdit = () => {
    setFormDesc(anime.description || '')
    setFormRating(anime.rating ? String(anime.rating) : '')
    setEditOpen(true)
  }
  const saveEdit = async () => {
    await updateAnime(anime.id, {
      description: formDesc,
      rating: Number(formRating) || 0
    })
    setEditOpen(false)
  }

  // 相关推荐：同流派的其他番剧
  const related = library
    .filter((a) => a.id !== anime.id && (a.genres || []).some((g) => (anime.genres || []).includes(g)))
    .slice(0, 8)

  const poster = (
    <Poster
      anime={anime}
      imgClassName="hero__poster-img"
      imgStyle={{ width: '100%', height: '100%' }}
      bgClassName="hero__poster-bg"
      style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div className="hero__poster-text">
        <div className="hero__poster-title">{anime.title}</div>
      </div>
    </Poster>
  )

  return (
    <div className="detail-page">
      {/* ===== 独立标题栏 ===== */}
      <header className="ds-wbtitlebar">
        <div className="ds-wbtitlebar__left">
          <button className="titlebar-back" aria-label="返回" onClick={() => navigate(-1)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <span className="ds-wbtitlebar__title">{anime.title}</span>
        </div>
        <div className="ds-wbtitlebar__right">
          <WindowControls />
        </div>
      </header>

      <main className="detail-main">
        {/* ===== Hero 横幅 ===== */}
        <section className="hero">
          <div className="hero__content">
            <div className="hero__poster">{poster}</div>

            <div className="hero__info">
              <div className="hero__title-row">
                <h1 className="hero__title">{anime.title}</h1>
                {anime.englishTitle && <div className="hero__subtitle">{anime.englishTitle}</div>}
                {anime.romaji && <div className="hero__romaji">{anime.romaji}</div>}
              </div>

              <div className="hero__tags">
                {(anime.genres || []).map((g) => (
                  <span key={g} className="ds-tag ds-tag--brand">{g}</span>
                ))}
                {anime.year ? <span className="ds-tag">{anime.year}</span> : null}
                <span className="ds-tag ds-tag--success">
                  <span className="hero__status-dot" />
                  {anime.status === 'completed' ? '完结' : '连载中'}
                </span>
              </div>

              <div className="hero__rating">
                <span className="hero__rating-score">{rating > 0 ? rating.toFixed(1) : '—'}</span>
                <span className="hero__rating-label">用户评分</span>
              </div>

              {anime.description && <p className="hero__desc">{anime.description}</p>}

              <div className="hero__actions">
                {cont && (
                  <button
                    className="ds-btn ds-btn--lg ds-btn--brand"
                    onClick={() => navigate(`/player/${anime.id}/${cont.id}`)}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                    继续观看 EP{cont.number}
                  </button>
                )}
                <button
                  className="ds-btn ds-btn--lg ds-btn--secondary hero__action-fav"
                  style={fav ? { color: 'var(--bg-brand)', borderColor: 'var(--bg-brand-popup)', background: 'var(--bg-brand-popup)' } : undefined}
                  onClick={toggleFav}
                >
                  {fav ? '已收藏' : '收藏'}
                </button>
                <button className="ds-btn ds-btn--lg ds-btn--secondary hero__action-edit" onClick={openEdit}>
                  编辑信息
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* ===== 统计卡 ===== */}
        <section className="stats-section">
          <div className="stats-grid">
            <div className="ds-statcard">
              <span className="ds-statcard__label">总集数</span>
              <span className="ds-statcard__value">{totalEpisodes}</span>
              {seasons.length > 1 && (
                <span className="ds-statcard__footer">共 {seasons.length} 季</span>
              )}
            </div>

            <div className="ds-statcard">
              <span className="ds-statcard__label">已观看</span>
              <span className="ds-statcard__value">{watchedCount}</span>
              {cont && (
                <span className="ds-statcard__footer">当前第 {cont.number} 集</span>
              )}
            </div>

            <div className="ds-statcard">
              <span className="ds-statcard__label">观看进度</span>
              <span className="ds-statcard__value">{pct}%</span>
              <div className="ds-statcard__progress">
                <div className="ds-statcard__progress-bar" style={{ width: `${pct}%` }} />
              </div>
            </div>

            <div className="ds-statcard">
              <span className="ds-statcard__label">我的评分</span>
              <span className="ds-statcard__value">
                {rating > 0 ? rating.toFixed(1) : '—'}
                <span className="ds-statcard__rating-suffix">/10</span>
              </span>
              <button className="ds-statcard__footer ds-statcard__rating-edit" onClick={openEdit}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></svg>
                编辑评分
              </button>
            </div>
          </div>
        </section>

        {/* ===== 内容区 Tabs ===== */}
        <section className="content-section">
          <div className="ds-tabs">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={`ds-tab${tab === t.key ? ' is-active' : ''}`}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="tab-panel">
            {/* 剧集列表 */}
            {tab === 'episodes' && (
              <>
                {seasons.length > 1 && (
                  <div className="season-selector">
                    {seasons.map((s) => (
                      <button
                        key={s}
                        className={`season-btn${s === activeSeason ? ' is-active' : ''}`}
                        onClick={() => setSeason(s)}
                      >
                        第 {s} 季
                      </button>
                    ))}
                  </div>
                )}

                {episodes.length === 0 ? (
                  <div className="detail-empty" style={{ padding: 'var(--spacer-40)' }}>暂无剧集</div>
                ) : (
                  <div className="episode-list">
                    {episodes.map((ep) => {
                      const stateCls = ep.watched
                        ? 'is-watched'
                        : ep.progress > 0
                          ? 'is-current'
                          : 'is-unwatched'
                      const showTime = ep.duration > 0
                      const durText = showTime ? formatTime(ep.duration) : ''
                      const progressShown = !ep.watched && ep.progress > 0 && ep.duration > 0
                      const pctEp = progressShown ? Math.min(100, Math.round((ep.progress / ep.duration) * 100)) : 0
                      return (
                        <div
                          key={ep.id}
                          className={`episode-item ${stateCls}`}
                          onClick={() => navigate(`/player/${anime.id}/${ep.id}`)}
                        >
                          <div className="episode__number">{String(ep.number).padStart(2, '0')}</div>
                          <div className="episode__info">
                            <div className="episode__title">{ep.title}</div>
                            <div className="episode__meta">
                              {showTime && (
                                <span className="episode__meta-item">
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></svg>
                                  {progressShown ? `${formatTime(ep.progress)} / ${durText}` : durText}
                                </span>
                              )}
                              {ep.airDate && (
                                <span className="episode__meta-item">
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>
                                  {shortDate(ep.airDate)}
                                </span>
                              )}
                            </div>
                          </div>

                          {progressShown && (
                            <div className="episode__progress">
                              <div className="episode__progress-bar">
                                <div className="episode__progress-fill" style={{ width: `${pctEp}%` }} />
                              </div>
                              <div className="episode__progress-text">{pctEp}%</div>
                            </div>
                          )}

                          <div className="episode__action">
                            <button
                              className={`episode__check${ep.watched ? ' is-on' : ''}`}
                              aria-label={ep.watched ? '标记为未观看' : '标记为已观看'}
                              onClick={(e) => {
                                e.stopPropagation()
                                setWatched(anime.id, ep.id, !ep.watched)
                              }}
                            >
                              {ep.watched ? (
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M8 12.5l2.5 2.5L16 9.5" /></svg>
                              ) : (
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /></svg>
                              )}
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </>
            )}

            {/* 详情信息 */}
            {tab === 'info' && (
              <div className="info-list">
                <div className="info-row">
                  <span className="info-row__key">声优</span>
                  <div className="info-row__value">
                    {(anime.voiceActors || []).length ? (
                      <span className="info-tags">
                        {(anime.voiceActors || []).map((v, i) => (
                          <span key={i} className="ds-tag">{v}</span>
                        ))}
                      </span>
                    ) : (
                      <span className="text-tertiary">暂无信息</span>
                    )}
                  </div>
                </div>
                <div className="info-row">
                  <span className="info-row__key">年份</span>
                  <div className="info-row__value">{anime.year || '—'}</div>
                </div>
                <div className="info-row">
                  <span className="info-row__key">工作室</span>
                  <div className="info-row__value">{anime.studio || '—'}</div>
                </div>
                <div className="info-row">
                  <span className="info-row__key">播出时间</span>
                  <div className="info-row__value">{anime.airDate ? shortDate(anime.airDate) : '—'}</div>
                </div>
                <div className="info-row">
                  <span className="info-row__key">标签</span>
                  <div className="info-row__value">
                    {(anime.tags || []).length ? (
                      <span className="info-tags">
                        {(anime.tags || []).map((t) => (
                          <span key={t} className="ds-tag ds-tag--brand">{t}</span>
                        ))}
                      </span>
                    ) : (
                      <span className="text-tertiary">暂无标签</span>
                    )}
                  </div>
                </div>
                <div className="info-row">
                  <span className="info-row__key">简介</span>
                  <div className="info-row__value" style={{ whiteSpace: 'pre-wrap' }}>
                    {anime.description || '暂无简介'}
                  </div>
                </div>
              </div>
            )}

            {/* 相关推荐 */}
            {tab === 'related' && (
              related.length ? (
                <div className="related-grid">
                  {related.map((a) => (
                    <div key={a.id} className="related-card" onClick={() => navigate(`/anime/${a.id}`)}>
                      <div className="related-card__poster">
                        <Poster
                          anime={a}
                          as="span"
                          imgStyle={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 12, textAlign: 'center', padding: 8, boxSizing: 'border-box' }}
                        />
                      </div>
                      <div className="related-card__name">{a.title}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="detail-empty" style={{ padding: 'var(--spacer-40)' }}>暂无相关推荐</div>
              )
            )}

            {/* 评论 */}
            {tab === 'comments' && (
              <div className="detail-empty" style={{ padding: 'var(--spacer-40)' }}>评论功能开发中…</div>
            )}
          </div>
        </section>
      </main>

      {/* ===== 编辑信息弹窗 ===== */}
      {editOpen && (
        <div className="ds-modal-backdrop" onClick={() => setEditOpen(false)}>
          <div className="ds-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="ds-dialog__head">
              <span className="ds-dialog__title">编辑信息</span>
              <button className="ds-dialog__close" aria-label="关闭" onClick={() => setEditOpen(false)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="ds-dialog__body">
              <div className="edit-form">
                <div className="edit-field">
                  <label className="edit-field__label">我的评分（0-10）</label>
                  <input
                    type="number"
                    min="0"
                    max="10"
                    step="0.1"
                    value={formRating}
                    placeholder="例如 9.5"
                    onChange={(e) => setFormRating(e.target.value)}
                  />
                </div>
                <div className="edit-field">
                  <label className="edit-field__label">简介</label>
                  <textarea
                    value={formDesc}
                    placeholder="填写番剧简介…"
                    onChange={(e) => setFormDesc(e.target.value)}
                  />
                </div>
              </div>
            </div>
            <div className="ds-dialog__foot">
              <button className="ds-btn ds-btn--secondary" onClick={() => setEditOpen(false)}>取消</button>
              <button className="ds-btn ds-btn--brand" onClick={saveEdit}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}