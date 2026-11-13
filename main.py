from fastapi import FastAPI, HTTPException
import pydantic
from tortoise.contrib.fastapi import register_tortoise
from models import Device, Device_Dto, Error_Dto, Point_Dto, Warning_Dto

app = FastAPI(title="KST Intelligent")

@app.get("/devices/{id}", response_model=Device_Dto)
async def get_device(id: int):
    device = await Device.get_or_none(id=id)
    if not device:
        raise HTTPException(status_code=404, detail="Устройство не найдено")
    return await Device_Dto.from_tortoise_orm(device)



register_tortoise(
    app,
    db_url="",
    modules={"models": ["models"]},
    generate_schemas=True,
    add_exception_handlers=True,
)
