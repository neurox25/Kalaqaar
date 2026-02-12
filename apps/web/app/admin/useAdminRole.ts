"use client";

import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { getAuth } from "firebase/auth";
import { httpsCallable } from "firebase/functions";

import { getFirebaseFunctions } from "../../lib/firebaseClient";

type Role = { role: "admin" | "auditor" | "ea" | "partner" | null; permissions: string[] };

type UseAdminRoleResult = {
  role: Role | null;
  loading: boolean;
  error: string | null;
  functions: any;
  refresh: () => void;
};

export function useAdminRole(): UseAdminRoleResult {
  const funcs = useMemo(() => getFirebaseFunctions(), []);
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const refreshedAdminToken = useRef(false);

  useEffect(() => {
    let mounted = true;

    async function fetchRole() {
      if (!funcs) {
        if (mounted) {
          setError("Firebase not configured. Set NEXT_PUBLIC_FIREBASE_* env vars.");
          setRole(null);
          setLoading(false);
        }
        return;
      }

      try {
        setLoading(true);
        
        // Check if user has admin role by checking their custom claims directly
        const auth = getAuth();
        const currentUser = auth.currentUser;
        
        if (!currentUser) {
          if (mounted) {
            setRole({ role: null, permissions: [] });
            setLoading(false);
          }
          return;
        }

        // 1) Preferred: custom claims (fast, no extra network).
        const idTokenResult = await currentUser.getIdTokenResult();
        const claims = idTokenResult.claims || {};
        const claimPermissions = Array.isArray((claims as any).permissions)
          ? ((claims as any).permissions as string[])
          : [];
        const claimRole: Role["role"] =
          (claims as any).admin ? "admin" :
          ((claims as any).auditor ? "auditor" :
          ((claims as any).ea ? "ea" :
          ((claims as any).partner ? "partner" : null)));

        if (claimRole) {
          if (mounted) {
            setRole({ role: claimRole, permissions: claimPermissions });
            setLoading(false);
          }
          return;
        }

        // 2) Backward-compatible: ask backend (uses Firestore roles/role).
        // This avoids hardcoding bypasses in admin pages.
        try {
          const getUserRole = httpsCallable(funcs, "getUserRole");
          const resp: any = await getUserRole({});
          const data = resp?.data || {};
          const roleStr = String(data.role || "").trim().toLowerCase();
          const rolesArr = Array.isArray(data.roles) ? data.roles.map((r: any) => String(r || "").trim().toLowerCase()) : [];
          const perms = Array.isArray(data.permissions) ? data.permissions.map((p: any) => String(p)) : [];

          const isAdmin =
            roleStr === "admin" ||
            roleStr === "super_admin" ||
            rolesArr.includes("admin") ||
            rolesArr.includes("super_admin") ||
            perms.includes("*");
          const isAuditor = roleStr === "auditor" || rolesArr.includes("auditor");
          const isEa = roleStr === "ea" || roleStr === "executive_assistant" || roleStr === "executive assistant" || rolesArr.includes("ea");
          const isPartner = roleStr === "partner" || rolesArr.includes("partner");

          const resolvedRole: Role = {
            role: isAdmin ? "admin" : (isAuditor ? "auditor" : (isEa ? "ea" : (isPartner ? "partner" : null))),
            permissions: perms,
          };
          if (mounted) {
            setRole(resolvedRole);
            setLoading(false);
          }
          return;
        } catch (fallbackErr) {
          // Fall through to no-role below.
        }

        if (mounted) {
          setRole({ role: null, permissions: [] });
          setLoading(false);
        }
      } catch (error) {
        console.error("Error fetching admin role:", error);
        if (mounted) {
          setError("Failed to verify admin access");
          setRole({ role: null, permissions: [] });
          setLoading(false);
        }
      }
    }

    const auth = getAuth();
    const unsubscribe = auth.onAuthStateChanged((user) => {
      if (user) {
        fetchRole();
      } else {
        if (mounted) {
          setRole({ role: null, permissions: [] });
          setLoading(false);
        }
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [funcs, refreshToken]);

  const refresh = useCallback(() => {
    setRefreshToken(prev => prev + 1);
  }, []);

  return { role, loading, error, functions: funcs, refresh };
}

export type { Role as AdminRole };
