#!/usr/bin/env python3
"""Small, real-S3 contract probe; passing is not production qualification.

Creates and deletes only a fresh probe object. Requires boto3==1.40.50.
The default credentials belong only to this isolated local MinIO lab.
"""

import argparse
import concurrent.futures
import hashlib
import json
import os
import threading
import uuid
from urllib.parse import urlparse

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", default="http://127.0.0.1:19860")
    parser.add_argument("--bucket", default="perch-celld-lab")
    parser.add_argument("--create-bucket", action="store_true")
    args = parser.parse_args()
    # This experiment deliberately does not use real cloud credentials.
    if urlparse(args.endpoint).hostname not in {"127.0.0.1", "localhost", "::1"}:
        parser.error("This local lab accepts only a loopback S3 endpoint")
    client = boto3.client(
        "s3",
        endpoint_url=args.endpoint,
        aws_access_key_id=os.environ.get("CELLD_LAB_ACCESS_KEY", "perch-local-lab"),
        aws_secret_access_key=os.environ.get(
            "CELLD_LAB_SECRET_KEY", "perch-local-lab-password"
        ),
        region_name="us-east-1",
        config=Config(
            s3={"addressing_style": "path"},
            connect_timeout=3,
            read_timeout=10,
            retries={"total_max_attempts": 1},
        ),
    )
    if args.create_bucket:
        try:
            client.create_bucket(Bucket=args.bucket)
        except ClientError as error:
            if error.response["Error"]["Code"] != "BucketAlreadyOwnedByYou":
                raise
    key = "probe/" + str(uuid.uuid4())
    common = {"Bucket": args.bucket, "Key": key}
    results = {"endpoint": args.endpoint, "bucket": args.bucket, "key": key}
    initial = bytes(range(256)) * 16
    replacement = b"# Artifact recovery\n\n" + initial[::-1]
    created = False

    def body():
        return client.get_object(**common)["Body"].read()

    def must_reject(**kwargs):
        try:
            client.put_object(**common, **kwargs)
        except ClientError as error:
            status = error.response["ResponseMetadata"]["HTTPStatusCode"]
            assert status == 412, error.response
            return status
        raise AssertionError("Server accepted a conditional write it must reject")

    try:
        first = client.put_object(**common, Body=initial, IfNoneMatch="*")
        created = True
        assert body() == initial
        results["create_read_after_write"] = "pass"
        results["conditional_create_rejection"] = must_reject(
            Body=b"must not replace", IfNoneMatch="*"
        )
        assert body() == initial
        second = client.put_object(
            **common, Body=replacement, IfMatch=first["ETag"]
        )
        assert body() == replacement
        results["conditional_update"] = "pass"
        results["stale_update_rejection"] = must_reject(
            Body=b"stale", IfMatch=first["ETag"]
        )
        ranged = client.get_object(**common, Range="bytes=7-273")["Body"].read()
        assert ranged == replacement[7:274]
        results["exact_byte_range"] = {
            "bytes": len(ranged),
            "sha256": hashlib.sha256(ranged).hexdigest(),
        }
        barrier = threading.Barrier(4)

        def compete(index):
            candidate = f"candidate-{index}\n".encode() + replacement
            barrier.wait(timeout=10)
            try:
                client.put_object(**common, Body=candidate, IfMatch=second["ETag"])
                return {"index": index, "status": 200, "body": candidate}
            except ClientError as error:
                status = error.response["ResponseMetadata"]["HTTPStatusCode"]
                assert status in {409, 412}, error.response
                return {"index": index, "status": status}

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            contestants = list(pool.map(compete, range(4)))
        winners = [result for result in contestants if result["status"] == 200]
        assert len(winners) == 1, contestants
        recovered = body()
        assert recovered == winners[0]["body"]
        listed = client.list_objects_v2(Bucket=args.bucket, Prefix=key)
        assert key in {item["Key"] for item in listed.get("Contents", [])}
        results["concurrent_compare_and_swap"] = {
            "writers": 4,
            "winners": 1,
            "statuses": [result["status"] for result in contestants],
        }
        results["artifact_bytes"] = {
            "bytes": len(recovered),
            "sha256": hashlib.sha256(recovered).hexdigest(),
        }
        results["listing_after_write"] = "pass"
        results["status"] = "passed"
    finally:
        # This unique object was created by this invocation only.
        if created:
            client.delete_object(**common)
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
