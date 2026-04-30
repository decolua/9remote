"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ADMIN_API } from "../constants";
import { useAdminApi } from "./useAdminApi";

export function useAdminAuth({ redirectIfUnauthed = true } = {}) {
  const router = useRouter();
  const { get, post } = useAdminApi();
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchMe = useCallback(async () => {
    try {
      const data = await get(ADMIN_API.me);
      setMe(data);
    } catch {
      setMe(null);
      if (redirectIfUnauthed) router.replace("/admin/login");
    } finally {
      setLoading(false);
    }
  }, [get, redirectIfUnauthed, router]);

  useEffect(() => { fetchMe(); }, [fetchMe]);

  const logout = useCallback(async () => {
    await post(ADMIN_API.logout, {});
    router.replace("/admin/login");
  }, [post, router]);

  const can = useCallback((perm) => Array.isArray(me?.permissions) && me.permissions.includes(perm), [me]);

  return { me, loading, logout, can, refresh: fetchMe };
}
