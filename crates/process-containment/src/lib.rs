//! Native lifetime containment established before the service starts child processes.

use std::io;

/// Keeps the platform containment object alive for the lifetime of the service.
pub struct ProcessContainment {
    #[cfg(windows)]
    _job: windows::JobHandle,
}

impl ProcessContainment {
    /// Activates the containment mode requested by the trusted desktop launcher.
    ///
    /// An absent marker supports direct CLI/test service launches. A requested native mode is
    /// fail-closed: initialization must succeed before any service-owned process can be created.
    ///
    /// # Errors
    ///
    /// Returns an error when the requested mode is invalid or the operating system cannot
    /// establish it for the current process.
    pub fn from_environment() -> io::Result<Option<Self>> {
        let Some(mode) = std::env::var_os("AGENT_WORKSPACE_SERVICE_CONTAINMENT") else {
            return Ok(None);
        };
        let mode = mode.to_str().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "invalid containment mode")
        })?;
        match mode {
            "graceful-only" => Ok(Some(Self {
                #[cfg(windows)]
                _job: windows::JobHandle::inactive(),
            })),
            #[cfg(target_os = "linux")]
            value if value.starts_with("linux-cgroup-v2:") => {
                linux::enter_cgroup(&value["linux-cgroup-v2:".len()..])?;
                Ok(Some(Self {}))
            }
            #[cfg(windows)]
            "windows-job-object" => Ok(Some(Self {
                _job: windows::JobHandle::create_and_assign_current_process()?,
            })),
            _ => Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "requested service process containment is unavailable",
            )),
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::{fs, io, path::Path};

    pub(super) fn enter_cgroup(path: &str) -> io::Result<()> {
        let path = Path::new(path);
        let canonical = fs::canonicalize(path)?;
        if !canonical.starts_with("/sys/fs/cgroup/") || canonical != path {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid service cgroup path",
            ));
        }
        fs::write(
            canonical.join("cgroup.procs"),
            std::process::id().to_string(),
        )
    }
}

#[cfg(windows)]
mod windows {
    use std::{ffi::c_void, io, mem::size_of};

    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                SetInformationJobObject,
            },
            Threading::GetCurrentProcess,
        },
    };

    pub(super) struct JobHandle(Option<HANDLE>);

    impl JobHandle {
        pub(super) const fn inactive() -> Self {
            Self(None)
        }

        pub(super) fn create_and_assign_current_process() -> io::Result<Self> {
            // SAFETY: Null security/name pointers request an unnamed, non-inheritable Job Object.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Self(Some(handle));
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: `limits` is initialized for the exact information class and remains live for
            // the duration of the call; `handle` is owned by `job`.
            let configured = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    (&raw const limits).cast::<c_void>(),
                    u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
                        .expect("Job Object information size fits u32"),
                )
            };
            if configured == 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: `GetCurrentProcess` returns a valid pseudo-handle and `handle` is a live Job.
            if unsafe { AssignProcessToJobObject(handle, GetCurrentProcess()) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }
    }

    impl Drop for JobHandle {
        fn drop(&mut self) {
            if let Some(handle) = self.0.take() {
                // SAFETY: This object uniquely owns the live Job handle.
                let _ = unsafe { CloseHandle(handle) };
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ProcessContainment;

    #[test]
    fn direct_launch_does_not_require_desktop_containment() {
        // The test suite may itself be launched by the desktop, so only assert the documented
        // direct-launch behavior when the marker is absent.
        if std::env::var_os("AGENT_WORKSPACE_SERVICE_CONTAINMENT").is_none() {
            assert!(ProcessContainment::from_environment().unwrap().is_none());
        }
    }
}
