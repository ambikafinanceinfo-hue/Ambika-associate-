import React, { useRef, useState } from 'react';
import { Camera, CheckCircle2, Mail, MapPin, Phone, Trash2, Upload, User, X } from 'lucide-react';
import { USER_ROLES, type AuthUser } from '../../shared/types';
import { apiFetch } from '../lib/api';
import type { Lang } from '../lib/i18n';

const DEFAULT_OFFICE_ADDRESS =
  '1ST FLOR ANUPAM COMPLEX,PATERI ROAD,NEAR RELIANCE BAZAR,SATNA MP(485001)';

interface ProfileModalProps {
  user: AuthUser;
  lang: Lang;
  officeAddress?: string;
  onProfileUpdated: (updated: AuthUser) => void;
  onOfficeAddressUpdated?: (nextAddress: string) => void;
  onClose: () => void;
}

async function compressImageToDataUrl(file: File, maxDim = 360): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read image file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Invalid image file'));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(String(reader.result));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export const ProfileModal: React.FC<ProfileModalProps> = ({
  user,
  lang,
  officeAddress,
  onProfileUpdated,
  onOfficeAddressUpdated,
  onClose,
}) => {
  const [fullName, setFullName] = useState(user.fullName);
  const [mobile, setMobile] = useState(user.mobile || '');
  const [email, setEmail] = useState(user.email || '');
  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(user.profilePhotoDataUrl ?? null);
  const [officeAddrDraft, setOfficeAddrDraft] = useState(
    officeAddress?.trim() || DEFAULT_OFFICE_ADDRESS
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const roleMeta = USER_ROLES.find((r) => r.value === user.role);
  const roleLabel = lang === 'hi' ? roleMeta?.labelHi || user.role : roleMeta?.labelEn || user.role;

  const initials = (fullName || user.fullName || 'AA')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');

  const handlePhotoSelected = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setSuccessMsg(null);
    try {
      const compressed = await compressImageToDataUrl(file, 360);
      setPhotoDataUrl(compressed);
    } catch (err: any) {
      setError(err?.message || 'Could not process selected photo');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    setSaving(true);
    try {
      const res = await apiFetch<{ user: AuthUser }>('/auth/profile', {
        method: 'PATCH',
        json: {
          fullName: fullName.trim(),
          mobile: mobile.trim(),
          email: email.trim(),
          profilePhotoDataUrl: photoDataUrl,
        },
      });
      if (user.role === 'SUPER_ADMIN' && officeAddrDraft.trim()) {
        await apiFetch('/admin/settings', {
          method: 'PATCH',
          json: { officeAddress: officeAddrDraft.trim() },
        });
        onOfficeAddressUpdated?.(officeAddrDraft.trim());
      }
      onProfileUpdated(res.user);
      setSuccessMsg(
        lang === 'hi'
          ? 'प्रोफ़ाइल सफलतापूर्वक अपडेट हो गई।'
          : 'Profile updated and saved successfully.'
      );
    } catch (err: any) {
      setError(err?.message || 'Failed to update profile');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[1px] flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl max-w-lg w-full border border-slate-200 shadow-2xl overflow-hidden my-auto">
        <div className="bg-[#0F2744] text-white px-5 py-4 flex items-center justify-between gap-3 border-b border-white/10">
          <div className="min-w-0">
            <h2 className="text-base font-display font-bold truncate">
              {lang === 'hi' ? 'मेरी प्रोफ़ाइल संपादित करें' : 'My Profile & Account Settings'}
            </h2>
            <p className="text-[11px] text-slate-300 truncate">
              {user.employeeCode} · {roleLabel}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Profile Modal"
            className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-white/10"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {error && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs font-medium text-[#DC2626]">
              {error}
            </div>
          )}
          {successMsg && (
            <div className="p-3 rounded-lg bg-green-50 border border-green-200 text-xs font-medium text-[#15803D] flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{successMsg}</span>
            </div>
          )}

          {/* Profile Photo Section */}
          <div className="flex flex-wrap items-center gap-4 p-3.5 rounded-xl bg-slate-50 border border-slate-200">
            <div className="w-16 h-16 rounded-full overflow-hidden border-2 border-[#0F2744]/20 bg-[#0F2744] text-white flex items-center justify-center text-lg font-display font-bold shrink-0">
              {photoDataUrl ? (
                <img
                  src={photoDataUrl}
                  alt={fullName}
                  className="w-full h-full object-cover"
                />
              ) : (
                <span>{initials || 'AA'}</span>
              )}
            </div>

            <div className="flex-1 min-w-0 space-y-2">
              <div className="text-xs font-semibold text-[#0F2744]">
                {lang === 'hi' ? 'प्रोफ़ाइल फ़ोटो' : 'Profile Photo'}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    handlePhotoSelected(e.target.files?.[0]);
                    e.currentTarget.value = '';
                  }}
                />
                <input
                  ref={cameraInputRef}
                  type="file"
                  accept="image/*"
                  capture="user"
                  className="hidden"
                  onChange={(e) => {
                    handlePhotoSelected(e.target.files?.[0]);
                    e.currentTarget.value = '';
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#0F2744] hover:bg-[#16365D] text-white text-[11px] font-semibold"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>{lang === 'hi' ? 'फ़ोटो चुनें' : 'Upload Photo'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => cameraInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-[11px] font-semibold"
                >
                  <Camera className="w-3.5 h-3.5" />
                  <span>{lang === 'hi' ? 'कैमरा' : 'Take Photo'}</span>
                </button>
                {photoDataUrl && (
                  <button
                    type="button"
                    onClick={() => setPhotoDataUrl(null)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-red-200 text-[#DC2626] hover:bg-red-50 text-[11px] font-semibold"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>{lang === 'hi' ? 'हटाएं' : 'Remove'}</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Read-only ID / Role summary */}
          <div className="grid grid-cols-2 gap-2.5 text-xs">
            <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
              <div className="text-[10px] font-semibold text-slate-500 uppercase">
                {lang === 'hi' ? 'लॉगिन / कर्मचारी ID' : 'Login / Employee ID'}
              </div>
              <div className="font-mono font-bold text-[#0F2744] mt-0.5">{user.employeeCode}</div>
            </div>
            <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
              <div className="text-[10px] font-semibold text-slate-500 uppercase">
                {lang === 'hi' ? 'भूमिका / शाखा' : 'Role / Branch'}
              </div>
              <div className="font-semibold text-[#0F2744] mt-0.5 truncate">
                {roleLabel}{user.branchName ? ` · ${user.branchName}` : ''}
              </div>
            </div>
          </div>

          {/* Official Head Office Address Detail */}
          <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[#0F2744]">
              <MapPin className="w-3.5 h-3.5 text-[#15803D] shrink-0" />
              <span>
                {lang === 'hi'
                  ? 'कार्यालय का पता (Ambika Office Address)'
                  : 'Ambika Office Address'}
              </span>
            </div>
            {user.role === 'SUPER_ADMIN' ? (
              <textarea
                rows={2}
                value={officeAddrDraft}
                onChange={(e) => setOfficeAddrDraft(e.target.value)}
                aria-label="Ambika Office Address"
                className="w-full px-2.5 py-1.5 text-xs font-medium bg-white border border-slate-300 rounded-lg text-[#0F2744] focus:outline-none focus:border-[#0F2744]"
              />
            ) : (
              <div className="text-xs font-semibold text-slate-800 leading-relaxed">
                {officeAddress?.trim() || DEFAULT_OFFICE_ADDRESS}
              </div>
            )}
            <div className="pt-1 border-t border-slate-200/80 flex items-center gap-1.5 text-[11px] text-slate-600">
              <Mail className="w-3.5 h-3.5 text-[#0F2744] shrink-0" />
              <span>
                {lang === 'hi' ? 'आधिकारिक ऐप व अपडेट ईमेल:' : 'Official App & Update Email:'}{' '}
                <strong className="font-mono text-[#0F2744]">ambikafinance.info@gmail.com</strong>
              </span>
            </div>
          </div>

          {/* Editable Name, Mobile, Email */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              {lang === 'hi' ? 'पूरा नाम (Full Name)' : 'Full Name'}
            </label>
            <div className="relative">
              <User className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                required
                minLength={2}
                maxLength={100}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Enter full name"
                className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:border-[#0F2744]"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              {lang === 'hi' ? 'मोबाइल नंबर (Mobile Number)' : 'Mobile Number'}
            </label>
            <div className="relative">
              <Phone className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="tel"
                required
                value={mobile}
                onChange={(e) => setMobile(e.target.value)}
                placeholder="10-digit mobile number"
                className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:border-[#0F2744]"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              {lang === 'hi' ? 'ईमेल आईडी (Email ID)' : 'Email ID'}
            </label>
            <div className="relative">
              <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@ambikaassociate.in"
                className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:border-[#0F2744]"
              />
            </div>
          </div>

          <div className="pt-2 flex items-center justify-end gap-2.5 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              {lang === 'hi' ? 'बंद करें' : 'Close'}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 rounded-lg bg-[#15803D] hover:bg-green-800 text-white text-xs font-semibold transition-colors disabled:opacity-60"
            >
              {saving
                ? lang === 'hi'
                  ? 'सहेजा जा रहा है...'
                  : 'Saving...'
                : lang === 'hi'
                ? 'प्रोफ़ाइल अपडेट करें'
                : 'Save Profile Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
