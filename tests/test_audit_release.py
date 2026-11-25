"""Release packaging checks with a synthetic Docker CLI; no real image save or deployment."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).parents[1].resolve()

class ReleasePackagingAudit(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="nexus-audit-package-")
        self.work = Path(self.temporary.name)
        binpath = self.work / "bin"
        binpath.mkdir()
        fake = binpath / "docker"
        fake.write_text("""#!/usr/bin/env python3
import json, os, pathlib, sys
with open(os.environ["AUDIT_PACKAGER_LOG"],"a") as out: out.write(json.dumps(sys.argv[1:])+"\\\\n")
if sys.argv[1:3]==["image","inspect"]:
    if os.environ.get("AUDIT_PACKAGER_FAIL")=="inspect": sys.exit(41)
    print("linux-amd64")
elif sys.argv[1:3]==["image","save"]:
    filename=pathlib.Path(sys.argv[sys.argv.index("-o")+1])
    filename.write_bytes(b"SYNTHETIC_IMAGE_FIXTURE_NOT_A_REAL_IMAGE")
    if os.environ.get("AUDIT_PACKAGER_FAIL")=="save": sys.exit(42)
else: sys.exit(43)
""".replace('"\\\\n"', '"\\n"'))
        fake.chmod(0o700)
        self.env = {**os.environ, "PATH": str(binpath)+os.pathsep+os.environ["PATH"],
                    "AUDIT_PACKAGER_LOG": str(self.work/"docker-arguments.jsonl")}
        version = json.loads((ROOT/"package.json").read_text())["version"]
        self.bundle = "nexus-panel-v"+version+"-linux-amd64"

    def tearDown(self):
        self.temporary.cleanup()

    def run_package(self, destination, failure=None):
        env = dict(self.env)
        if failure: env["AUDIT_PACKAGER_FAIL"] = failure
        return subprocess.run(["bash",str(ROOT/"scripts/package-release.sh"),str(destination)],
                              cwd=ROOT,env=env,capture_output=True,text=True,timeout=30)

    def test_bundle_retains_documentation_collector_layout_and_checksum_in_space_path(self):
        destination=self.work/"release with spaces"
        result=self.run_package(destination)
        self.assertEqual(result.returncode,0,result.stderr)
        archive=destination/(self.bundle+".tar.gz")
        checksum=destination/(self.bundle+".tar.gz.sha256")
        self.assertEqual(checksum.read_text().split()[0],hashlib.sha256(archive.read_bytes()).hexdigest())
        with tarfile.open(archive) as package:
            names=set(package.getnames())
            version=json.loads((ROOT/"package.json").read_text())["version"]
            required={"docker-compose.yml",".env.example","LICENSE","THIRD_PARTY_NOTICES.md","deployment.md",
                      "docs/deployment.md","docs/architecture.md","docs/api-contract.md","docs/frontend.md",
                      "docs/testing.md","docs/migration.md","docs/observability.md","docs/homepage-fonts.md",
                      "docs/releases/v"+version+".md","licenses/LiuJianMaoCao-OFL.txt",
                      "examples/integrations.example.json","scripts/collect-tasks.py","nexus-panel-image.tar"}
            for name in required:self.assertIn(self.bundle+"/"+name,names)
            for source in (ROOT/"docs").rglob("*"):
                if source.is_file():
                    self.assertIn(self.bundle+"/docs/"+source.relative_to(ROOT/"docs").as_posix(),names)
            root_guide=package.extractfile(self.bundle+"/deployment.md").read().decode()
            self.assertIn("[the deployment guide](docs/deployment.md)",root_guide)
            self.assertEqual(package.extractfile(self.bundle+"/docs/deployment.md").read(),(ROOT/"docs/deployment.md").read_bytes())
            forbidden={".env",".env.preview","nexus.db","node_modules","artifacts"}
            self.assertFalse(any(set(Path(name).parts)&forbidden for name in names))
            config=json.load(package.extractfile(self.bundle+"/examples/integrations.example.json"))
            self.assertTrue(all(".invalid" in c["baseUrl"] for c in config["connections"]))
            self.assertEqual(package.extractfile(self.bundle+"/nexus-panel-image.tar").read(),b"SYNTHETIC_IMAGE_FIXTURE_NOT_A_REAL_IMAGE")
            license_text=package.extractfile(self.bundle+"/licenses/LiuJianMaoCao-OFL.txt").read().decode()
            self.assertIn("Copyright 2018 The Liu Jian Mao Cao Project Authors",license_text)
            self.assertIn("SIL OPEN FONT LICENSE Version 1.1",license_text)
            notices=package.extractfile(self.bundle+"/THIRD_PARTY_NOTICES.md").read().decode()
            self.assertIn("Liu Jian Mao Cao",notices)
            expected_image="nexus-panel:"+version
            compose=package.extractfile(self.bundle+"/docker-compose.yml").read().decode()
            example=package.extractfile(self.bundle+"/.env.example").read().decode()
            self.assertIn("${NEXUS_IMAGE:-"+expected_image+"}",compose)
            self.assertIn("NEXUS_IMAGE="+expected_image,example)

    def test_missing_source_image_fails_without_publishing_bundle(self):
        destination=self.work/"missing-image"
        result=self.run_package(destination,"inspect")
        self.assertNotEqual(result.returncode,0)
        self.assertFalse(destination.exists())

    def test_partial_image_save_failure_never_publishes_partial_archive(self):
        destination=self.work/"partial"
        result=self.run_package(destination,"save")
        self.assertNotEqual(result.returncode,0)
        self.assertFalse(list(destination.glob("*.tar.gz*")))

    def test_repeat_packaging_has_consistent_names_and_matching_checksums(self):
        destination=self.work/"repeat"
        for _ in range(2):
            result=self.run_package(destination)
            self.assertEqual(result.returncode,0,result.stderr)
            archive=destination/(self.bundle+".tar.gz")
            actual=hashlib.sha256(archive.read_bytes()).hexdigest()
            self.assertEqual((destination/(self.bundle+".tar.gz.sha256")).read_text().split()[0],actual)
        self.assertEqual(len(list(destination.iterdir())),2)

if __name__=="__main__":
    unittest.main()
