import { useEffect, useState } from 'react';
import { Loader2, UserPlus, Building2, Store, ToggleLeft, ToggleRight, Pencil, Trash2 } from 'lucide-react';
import { useFacility } from '../context/FacilityContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import {
  fetchUsers,
  updateUserRole,
  setUserActive,
  inviteUser,
  deleteUserAccount,
  addFacility,
  addPharmacy,
  updatePharmacy,
  deletePharmacy,
} from '../lib/settingsApi.js';
import { SkeletonTable } from '../components/common/Skeleton.jsx';

function UsersPanel() {
  const toast = useToast();
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('regular');
  const [inviting, setInviting] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  async function load() {
    setLoading(true);
    try {
      setUsers(await fetchUsers());
    } catch (err) {
      toast.error(`Failed to load users: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleInvite(e) {
    e.preventDefault();
    if (!email.trim()) return;
    setInviting(true);
    try {
      await inviteUser(email.trim(), role);
      toast.success(`Invitation sent to ${email}.`);
      setEmail('');
      await load();
    } catch (err) {
      toast.error(`Invite failed: ${err.message}`);
    } finally {
      setInviting(false);
    }
  }

  async function handleRoleChange(userId, newRole) {
    try {
      await updateUserRole(userId, newRole);
      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, role: newRole } : u)));
      toast.success('Role updated.');
    } catch (err) {
      toast.error(`Role update failed: ${err.message}`);
    }
  }

  async function handleToggleActive(user) {
    try {
      await setUserActive(user.id, !user.active);
      setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, active: !u.active } : u)));
      toast.success(user.active ? 'User deactivated.' : 'User reactivated.');
    } catch (err) {
      toast.error(`Update failed: ${err.message}`);
    }
  }

  async function handleDelete(user) {
    if (
      !window.confirm(
        `Permanently delete ${user.email}? This cannot be undone. If this account has ever uploaded a claim or touched the ` +
          `accumulator, the delete will be blocked — deactivate it instead to preserve the audit trail.`
      )
    )
      return;
    setDeletingId(user.id);
    try {
      await deleteUserAccount(user.id);
      setUsers((prev) => prev.filter((u) => u.id !== user.id));
      toast.success(`${user.email} deleted.`);
    } catch (err) {
      toast.error(`Delete failed: ${err.message}`);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="card p-6">
      <h2 className="mb-4 text-base font-semibold text-navy">Users</h2>

      <form onSubmit={handleInvite} className="mb-6 flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[200px]">
          <label className="label-text">Invite by email</label>
          <input type="email" className="input-field" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@onehealthpartners.com" />
        </div>
        <div>
          <label className="label-text">Role</label>
          <select className="input-field" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="regular">Regular</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <button type="submit" className="btn-primary" disabled={inviting}>
          {inviting ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
          Invite
        </button>
      </form>

      {loading ? (
        <SkeletonTable rows={4} cols={4} />
      ) : (
        <div className="overflow-auto rounded-lg border border-gray-100">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-alt">
              <tr>
                <th className="px-4 py-2.5 font-semibold text-navy">Email</th>
                <th className="px-4 py-2.5 font-semibold text-navy">Role</th>
                <th className="px-4 py-2.5 font-semibold text-navy">Status</th>
                <th className="px-4 py-2.5 font-semibold text-navy">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u, i) => (
                <tr key={u.id} className={i % 2 ? 'bg-surface-alt' : 'bg-white'}>
                  <td className="px-4 py-2.5">{u.email}</td>
                  <td className="px-4 py-2.5">
                    <select className="input-field w-32 py-1" value={u.role} onChange={(e) => handleRoleChange(u.id, e.target.value)}>
                      <option value="regular">Regular</option>
                      <option value="admin">Admin</option>
                    </select>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`badge ${u.active ? 'bg-green-50 text-success' : 'bg-gray-100 text-gray-500'}`}>
                      {u.active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <button className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-teal" onClick={() => handleToggleActive(u)}>
                        {u.active ? <ToggleRight className="h-5 w-5 text-teal" /> : <ToggleLeft className="h-5 w-5" />}
                        {u.active ? 'Deactivate' : 'Reactivate'}
                      </button>
                      {u.id !== currentUser?.id && (
                        <button
                          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-danger"
                          onClick={() => handleDelete(u)}
                          disabled={deletingId === u.id}
                          title="Permanently delete this account"
                        >
                          {deletingId === u.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FacilitiesPanel() {
  const { facilities, refresh } = useFacility();
  const toast = useToast();
  const [name, setName] = useState('');
  const [shortCode, setShortCode] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleAdd(e) {
    e.preventDefault();
    if (!name.trim() || !shortCode.trim()) return;
    setSaving(true);
    try {
      await addFacility({ name: name.trim(), shortCode: shortCode.trim().toUpperCase(), notes: notes.trim() || null });
      toast.success('Facility added.');
      setName('');
      setShortCode('');
      setNotes('');
      await refresh();
    } catch (err) {
      toast.error(`Failed to add facility: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card p-6">
      <h2 className="mb-4 text-base font-semibold text-navy">Facilities</h2>
      <div className="mb-4 divide-y divide-gray-100 rounded-lg border border-gray-100">
        {facilities.map((f) => (
          <div key={f.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
            <span className="font-medium text-navy">{f.name}</span>
            <span className="text-gray-500">{f.short_code}</span>
          </div>
        ))}
      </div>
      <form onSubmit={handleAdd} className="flex flex-wrap items-end gap-3">
        <div>
          <label className="label-text">Name</label>
          <input className="input-field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Facility name" />
        </div>
        <div>
          <label className="label-text">Short Code</label>
          <input className="input-field w-32" value={shortCode} onChange={(e) => setShortCode(e.target.value)} placeholder="e.g. HRTLD" />
        </div>
        <div className="flex-1 min-w-[160px]">
          <label className="label-text">Notes</label>
          <input className="input-field" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </div>
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Building2 className="h-4 w-4" />}
          Add Facility
        </button>
      </form>
    </div>
  );
}

function FacilityCheckboxes({ facilities, selected, onToggle }) {
  return (
    <div className="flex flex-wrap gap-2">
      {facilities.map((f) => (
        <label
          key={f.id}
          className={`badge cursor-pointer border ${selected.includes(f.id) ? 'border-teal bg-teal-50 text-teal-700' : 'border-gray-200 text-gray-500'}`}
        >
          <input type="checkbox" className="mr-1.5" checked={selected.includes(f.id)} onChange={() => onToggle(f.id)} />
          {f.name}
        </label>
      ))}
    </div>
  );
}

function PharmacyRow({ pharmacy, facilities, onSaved }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(pharmacy.name);
  const [selectedFacilities, setSelectedFacilities] = useState((pharmacy.pharmacy_facilities ?? []).map((pf) => pf.facility_id));
  const [saving, setSaving] = useState(false);

  function toggleFacility(id) {
    setSelectedFacilities((prev) => (prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id]));
  }

  function startEdit() {
    setName(pharmacy.name);
    setSelectedFacilities((pharmacy.pharmacy_facilities ?? []).map((pf) => pf.facility_id));
    setEditing(true);
  }

  async function handleSave() {
    if (!name.trim()) {
      toast.error('Pharmacy name cannot be empty.');
      return;
    }
    setSaving(true);
    try {
      await updatePharmacy({ id: pharmacy.id, name: name.trim(), facilityIds: selectedFacilities });
      toast.success('Pharmacy updated.');
      setEditing(false);
      await onSaved();
    } catch (err) {
      toast.error(`Update failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete pharmacy "${pharmacy.name}"? This cannot be undone.`)) return;
    setSaving(true);
    try {
      await deletePharmacy(pharmacy.id);
      toast.success('Pharmacy deleted.');
      await onSaved();
    } catch (err) {
      toast.error(`Delete failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="space-y-3 px-4 py-3 text-sm">
        <input className="input-field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Pharmacy name" />
        <FacilityCheckboxes facilities={facilities} selected={selectedFacilities} onToggle={toggleFacility} />
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={() => setEditing(false)} disabled={saving}>
            Cancel
          </button>
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
      <div className="min-w-0">
        <span className="font-medium text-navy">{pharmacy.name}</span>
        <span className="ml-2 text-gray-500">
          {(pharmacy.pharmacy_facilities ?? [])
            .map((pf) => facilities.find((f) => f.id === pf.facility_id)?.name)
            .filter(Boolean)
            .join(', ') || 'No facilities linked'}
        </span>
      </div>
      <div className="flex flex-shrink-0 items-center gap-1.5">
        <button className="btn-secondary px-2 py-1" onClick={startEdit} disabled={saving} title="Rename / edit facilities">
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button className="btn-secondary px-2 py-1 text-danger" onClick={handleDelete} disabled={saving} title="Delete pharmacy">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}

function PharmaciesPanel() {
  const { facilities, pharmacies, refresh } = useFacility();
  const toast = useToast();
  const [name, setName] = useState('');
  const [selectedFacilities, setSelectedFacilities] = useState([]);
  const [saving, setSaving] = useState(false);

  function toggleFacility(id) {
    setSelectedFacilities((prev) => (prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id]));
  }

  async function handleAdd(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await addPharmacy({ name: name.trim(), facilityIds: selectedFacilities });
      toast.success('Pharmacy added.');
      setName('');
      setSelectedFacilities([]);
      await refresh();
    } catch (err) {
      toast.error(`Failed to add pharmacy: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card p-6">
      <h2 className="mb-4 text-base font-semibold text-navy">Pharmacies</h2>
      <div className="mb-4 divide-y divide-gray-100 rounded-lg border border-gray-100">
        {pharmacies.length === 0 && <p className="px-4 py-3 text-sm text-gray-400">No pharmacies yet.</p>}
        {pharmacies.map((p) => (
          <PharmacyRow key={p.id} pharmacy={p} facilities={facilities} onSaved={refresh} />
        ))}
      </div>
      <form onSubmit={handleAdd} className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[200px]">
            <label className="label-text">Name</label>
            <input className="input-field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Pharmacy name" />
          </div>
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Store className="h-4 w-4" />}
            Add Pharmacy
          </button>
        </div>
        <div>
          <label className="label-text">Associated Facilities</label>
          <FacilityCheckboxes facilities={facilities} selected={selectedFacilities} onToggle={toggleFacility} />
        </div>
      </form>
    </div>
  );
}

export default function Settings() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-navy">Settings</h1>
        <p className="text-sm text-gray-500">Admin: manage users, facilities, and pharmacies</p>
      </div>
      <UsersPanel />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <FacilitiesPanel />
        <PharmaciesPanel />
      </div>
    </div>
  );
}
